import type Database from 'better-sqlite3';
import { createFieldMap } from '../fields/field-map.js';
import { ok, type Issue } from '../mcp/tools/errors.js';
import { evaluateSummaryInSnapshot } from '../summaries/service.js';
import { SummaryError } from '../summaries/errors.js';
import type { SummaryData } from '../summaries/types.js';
import { compileRollups, publicRollupDetails } from './compile.js';
import { RollupError } from './definitions.js';
import type { ReadRollupsData } from './types.js';
export function readRollups(
  db: Database.Database,
  input: unknown,
): ReturnType<typeof ok> {
  return db
    .transaction(() => {
      const c = compileRollups(db, input);
      let source: { data: SummaryData; warnings: Issue[] };
      try {
        source = evaluateSummaryInSnapshot(db, c.summaryRequest);
      } catch (e) {
        if (e instanceof SummaryError)
          throw new RollupError(
            e.code,
            e.message,
            publicRollupDetails(c, e.details),
          );
        throw e;
      }
      const data: ReadRollupsData = {
        kind: 'node_rollups',
        ...(source.data.classification_dependencies ? {classification_dependencies:source.data.classification_dependencies} : {}),
        ...(source.data.evaluation_context ? {evaluation_context:source.data.evaluation_context} : {}),
        version: 1,
        schema: c.request.schema,
        relationship_views_hash: c.discovery.relationship_views_hash,
        definitions: {
          rollups: [...c.aliases.rollups.keys()].map((name) =>
            c.discovery.rollups.find((r) => r.definition.name === name)!,
          ),
          relations: [...c.aliases.relations].map(([name, alias]) => ({
            definition: c.discovery.relations.find(
              (r) => r.definition.name === name,
            )!.definition,
            lookup: source.data.definitions.find((r) => r.as === alias)!
              .lookup!,
          })),
        },
        rows: source.data.rows.map((row) => {
          const rollups =
              createFieldMap<
                ReadRollupsData['rows'][number]['rollups'][string]
              >(),
            relations =
              createFieldMap<
                ReadRollupsData['rows'][number]['relations'][string]
              >();
          for (const [name, a] of c.aliases.rollups)
            rollups[name] = row.relations[a.relation].metrics[a.metric];
          for (const [name, a] of c.aliases.relations)
            relations[name] = row.relations[a].lookup!;
          const details = createFieldMap<NonNullable<ReadRollupsData['rows'][number]['rollup_details']>[string]>();
          for (const [name,a] of c.aliases.rollups) {
            const value=row.relations[a.relation].metric_details?.[a.metric];
            if (value) details[name]=value;
          }
          return { node: row.node, rollups, relations, ...(Object.keys(details).length ? {rollup_details:details} : {}) };
        }),
        page: source.data.page,
      };
      const warnings = source.warnings.map((w) => ({
        ...w,
        details: publicRollupDetails(
          c,
          (w.details ?? {}) as Record<string, unknown>,
        ),
      }));
      const result = ok(data, warnings),
        bytes = Buffer.byteLength(result.content[0].text, 'utf8');
      if (bytes > 1048576)
        throw new RollupError(
          'INVALID_PARAMS',
          'Rollup response exceeds capacity; narrow selections.',
          {
            reason: 'QUERY_LIMIT_EXCEEDED',
            stage: 'response_bytes',
            limit: 1048576,
            observed_at_least: bytes,
          },
        );
      return result;
    })
    .deferred();
}
