import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { referenceEditFixture } from '../helpers/reference-edit.js';
import { executeReferenceEdit } from '../../src/reference-edits/execute.js';
import { referenceEditResult } from '../../src/mcp/tools/reference-edit.js';

const report: unknown[] = [];
it.each([[100, 1000], [1000, 1000], [100, 50_000], [1000, 50_000]])('reference edit cost: %i members, %i nodes', (members, nodes) => {
  let scans = 0;
  const f = referenceEditFixture({ project: ['P1', ...Array.from({ length: members - 1 }, (_, i) => `Missing${i}`)] }, {
    verbose(sql) { if (typeof sql === 'string' && sql.startsWith('SELECT id, file_path, title FROM nodes')) scans++; },
  });
  try {
    const insert = f.db.prepare('INSERT INTO nodes(id, file_path, title) VALUES (?, ?, ?)');
    f.db.transaction(() => { for (let i = 4; i < nodes; i++) insert.run(`extra${i}`, `Extra${i}.md`, `Extra${i}`); })();
    const measurements = [];
    // At the list cap use an existing-member add; a 1001st entry must be rejected.
    for (const [action, dry_run, target] of [
      ['add', true, f.projectIds[members === 1000 ? 0 : 1]],
      ['add', false, f.projectIds[members === 1000 ? 0 : 1]],
      ['remove', false, f.projectIds[0]],
      ['add', false, f.projectIds[0]],
    ] as const) {
      scans = 0;
      const start = performance.now();
      const response = executeReferenceEdit(f, { node_id: f.taskId, reference_edit: { field: 'project', action, target: { node_id: target } }, dry_run }, referenceEditResult);
      const ms = performance.now() - start;
      expect(JSON.parse(response.content[0].text).ok).toBe(true);
      expect(scans).toBe(1);
      measurements.push({ action, dry_run, ms: Math.round(ms * 100) / 100, catalog_queries: scans });
    }
    const identityBytes = (f.db.prepare("SELECT sum(length(CAST(json_object('id', id, 'file_path', file_path, 'title', title) AS BLOB))) AS bytes FROM nodes").get() as { bytes: number }).bytes;
    report.push({ members, nodes, identity_bytes: identityBytes, measurements });
    writeFileSync(join(tmpdir(), 'vault-reference-edit-benchmark.json'), JSON.stringify(report, null, 2));
  } finally { f.cleanup(); }
});
