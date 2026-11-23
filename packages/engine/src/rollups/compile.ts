import { assertExpressionBudget, FilterExpressionError, type FilterScope } from '../filters/expression.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { evaluationContextSchema } from '../summaries/temporal.js';
import {
  filterSchema,
  parseSummaryRequest,
  validateSummaryRequest,
} from '../summaries/input.js';
import type {
  SummaryRelation,
  SummaryRequest,
  SummarySort,
} from '../summaries/types.js';
import {
  canonicalJson,
  describeRelationshipViews,
  RollupError,
  savedName,
} from './definitions.js';
import { DEFAULT_EXAMPLE_NAMES, exampleKey, type ExampleNames } from '../mcp/example-names.js';
import type {
  ReadRollupsRequest,
  RelationshipViewsDiscovery,
  SavedRelation,
} from './types.js';
const order = z.enum(['asc', 'desc']);
/** The relations[].fields description; its example fields come from the vault map. */
export function rollupFieldsDescription(n: ExampleNames): string {
  return `Additional scalar typed global fields, e.g. ${n.taskStatus} and ${n.due}. Each item already includes id, title, file_path and version; omit those unless selecting a separate global field of that name. Discover field definitions with describe-schema or list-global-fields.`;
}
/** The filter description; its example predicate comes from the vault map. */
export function rollupFilterDescription(n: ExampleNames): string {
  return `Parent filter intersected with the owning schema. Put typed field predicates under filter.fields, e.g. ${rollupFilterExample(n)}; use title_eq/title_contains for node titles. where supplies bounded AND/OR expressions.`;
}
/** `{fields:{status:{ne:"done"}}}` in the vault's own names. */
export function rollupFilterExample(n: ExampleNames): string {
  return `{fields:{${exampleKey(n.projectStatus)}:{ne:${JSON.stringify(n.projectDone)}}}}`;
}
export const readRollupsRequestSchema = z
  .object({
    evaluation_context: evaluationContextSchema.optional(),
    schema: z.string().min(1).max(1024),
    rollups: z.array(savedName).max(8).default([])
      .describe('Select up to eight saved names; multiple rollups may be selected while sorting by one of them.'),
    relations: z
      .array(
        z
          .object({
            name: savedName,
            fields: z.array(z.string().min(1).max(1024)).max(5).default([])
              .describe(rollupFieldsDescription(DEFAULT_EXAMPLE_NAMES)),
            limit: z.number().int().min(1).max(10).default(5),
          })
          .strict(),
      )
      .max(4)
      .default([]),
    filter: filterSchema.default({})
      .describe(rollupFilterDescription(DEFAULT_EXAMPLE_NAMES)),
    sort: z
      .union([
        z.object({ by: z.enum(['id', 'title']), order }).strict(),
        z.object({ by: z.literal('rollup'), name: savedName, order }).strict(),
      ])
      .default({ by: 'title', order: 'asc' })
      .describe('One sort key before pagination: {by:"rollup",name:"selected_rollup_name",order:"desc"}, or by:"id"/"title" with order. Sorting does not require selecting only one rollup.'),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .refine(
    (v) => v.rollups.length + v.relations.length > 0,
    'Select saved rollups or relations',
  );
export interface CompiledRollups {
  request: ReadRollupsRequest;
  summaryRequest: SummaryRequest;
  discovery: RelationshipViewsDiscovery;
  aliases: {
    rollups: Map<string, { relation: string; metric: string }>;
    relations: Map<string, string>;
  };
}
export function compileRollups(
  db: Database.Database,
  input: unknown,
): CompiledRollups {
  const checkBudget=(scopes:FilterScope[])=>{
    try { assertExpressionBudget(scopes); }
    catch(error) { if(error instanceof FilterExpressionError) throw new RollupError('INVALID_PARAMS',error.message,error.details); throw error; }
  };
  checkBudget([{filter:(input as ReadRollupsRequest|null)?.filter,profile:'summary',path:'filter'}]);
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    /* Rejected below. */
  }
  if (text === undefined || Buffer.byteLength(text) > 65536)
    throw new RollupError(
      'INVALID_PARAMS',
      'Rollup request exceeds 64 KiB or is not JSON.',
    );
  if (
    input &&
    typeof input === 'object' &&
    Object.keys(input).some(
      (k) =>
        ![
          'evaluation_context',
          'schema',
          'rollups',
          'relations',
          'filter',
          'sort',
          'limit',
          'offset',
        ].includes(k),
    )
  )
    throw new RollupError('INVALID_PARAMS', 'Unknown rollup argument.');
  const parsed = readRollupsRequestSchema.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.code === 'unrecognized_keys'
      && issue.path.length === 1 && issue.path[0] === 'filter')) {
      throw new RollupError('INVALID_PARAMS',
        'Invalid rollup filter keys. Put typed field predicates under filter.fields, e.g. {fields:{status:{ne:"done"}}}; use title_eq/title_contains for node titles.');
    }
    if (parsed.error.issues.some(issue => issue.path[0] === 'sort')) {
      throw new RollupError('INVALID_PARAMS',
        'Invalid rollup sort. Use {by:"rollup",name:"selected_rollup_name",order:"asc"|"desc"}, or by:"id"/"title" with order. Multiple rollups may be selected.');
    }
    throw new RollupError(
      'INVALID_PARAMS',
      'Invalid saved-rollup selection, shape or limit.',
    );
  }
  const request = parsed.data as z.infer<typeof readRollupsRequestSchema>;
  if (
    new Set(request.rollups).size !== request.rollups.length ||
    new Set(request.relations.map((r) => r.name)).size !==
      request.relations.length
  )
    throw new RollupError(
      'INVALID_PARAMS',
      'Selected saved names must be unique.',
    );
  if (request.filter.without_types?.includes(request.schema))
    throw new RollupError(
      'INVALID_PARAMS',
      'Cannot exclude the owning schema.',
    );
  const discovery = describeRelationshipViews(db, request.schema);
  if (
    discovery.state === 'unsupported' ||
    (discovery.state === 'invalid' &&
      !discovery.relations.length &&
      !discovery.rollups.length)
  )
    throw new RollupError('VALIDATION_FAILED', 'Invalid saved definitions.', {
      reason: 'INVALID_ROLLUP_DEFINITION',
      schema: request.schema,
    });
  const effectiveScopes:FilterScope[]=[{filter:{...request.filter,types:[...new Set([request.schema,...request.filter.types??[]])]},profile:'summary',path:'filter'}];
  const relations: SummaryRelation[] = [],
    packed = new Map<string, SummaryRelation>();
  const aliases: CompiledRollups['aliases'] = {
    rollups: new Map(),
    relations: new Map(),
  };
  const pack = (
    relation: SavedRelation,
    fields: object = {},
  ): SummaryRelation => {
    const filter = { ...relation.filter, ...fields },
      key = canonicalJson({
        field: relation.field,
        direction: relation.direction,
        filter,
      });
    let value = packed.get(key);
    if (!value) {
      value = {
        as: `r${relations.length}`,
        direction: relation.direction,
        field: relation.field,
        filter,
        metrics: [],
      };
      relations.push(value);
      packed.set(key, value);
    }
    return value;
  };
  const invalid = (name: string): never => {
    throw new RollupError(
      'VALIDATION_FAILED',
      'Selected definition has an invalid dependency.',
      { reason: 'INVALID_ROLLUP_DEFINITION', schema: request.schema, name },
    );
  };
  for (const name of request.rollups) {
    const rollup = discovery.rollups.find((r) => r.definition.name === name);
    if (!rollup)
      throw new RollupError('INVALID_PARAMS', 'Unknown saved rollup.', {
        name,
      });
    if (rollup.state !== 'valid') invalid(name);
    const relation = discovery.relations.find(
      (r) => r.definition.name === rollup.definition.relation,
    )!;
    effectiveScopes.push({filter:{...relation.definition.filter,...rollup.definition.filter},profile:'summary',path:`rollups.${name}.filter`});
    if(rollup.definition.metric.op==='percentage') effectiveScopes.push({filter:rollup.definition.metric.matching_filter,profile:'fields',path:`rollups.${name}.matching_filter`});
    const target = pack(relation.definition, rollup.definition.filter),
      metric = `m${target.metrics!.length}`;
    target.metrics!.push({ as: metric, ...rollup.definition.metric });
    aliases.rollups.set(name, { relation: target.as, metric });
  }
  for (const selection of request.relations) {
    const relation = discovery.relations.find(
      (r) => r.definition.name === selection.name,
    );
    if (!relation)
      throw new RollupError('INVALID_PARAMS', 'Unknown saved relation.', {
        name: selection.name,
      });
    if (relation.state !== 'valid') invalid(selection.name);
    for (const field of selection.fields) {
      if (!db.prepare('SELECT 1 FROM global_fields WHERE name=?').get(field)) {
        throw new RollupError('INVALID_PARAMS',
          `Unknown relation lookup field: ${field}. Related items already include id, title, file_path and version. Select additional scalar typed global fields, e.g. status or due; discover them with describe-schema or list-global-fields.`,
          { rollups: request.rollups, relations: request.relations.map(r => r.name), field, relation: selection.name });
      }
    }
    effectiveScopes.push({filter:relation.definition.filter,profile:'summary',path:`relations.${selection.name}.filter`});
    const target = pack(relation.definition);
    // Identical aliases can request different projections; keep separate descriptors then.
    let selected = target;
    if (
      target.lookup &&
      canonicalJson(target.lookup) !==
        canonicalJson({ fields: selection.fields, limit: selection.limit })
    ) {
      const lookup = { fields: selection.fields, limit: selection.limit };
      const shared = relations.find(
        (r) =>
          r.field === target.field &&
          r.direction === target.direction &&
          canonicalJson(r.filter) === canonicalJson(target.filter) &&
          r.lookup !== undefined &&
          canonicalJson(r.lookup) === canonicalJson(lookup),
      );
      selected = shared ?? {
        ...target,
        as: `r${relations.length}`,
        metrics: [],
      };
      if (!shared) relations.push(selected);
    }
    selected.lookup = { fields: selection.fields, limit: selection.limit };
    aliases.relations.set(selection.name, selected.as);
  }
  checkBudget(effectiveScopes);
  let sort: SummarySort;
  if (request.sort.by === 'rollup') {
    const name = aliases.rollups.get(request.sort.name);
    if (!name)
      throw new RollupError(
        'INVALID_PARAMS',
        'Sort must name one selected rollup. Multiple rollups may be selected; set sort.name to one of those names.',
      );
    sort = { by: 'metric', ...name, order: request.sort.order };
  } else sort = request.sort;
  const summaryRequest = {
    ...(request.evaluation_context ? {evaluation_context:request.evaluation_context} : {}),
    filter: {
      ...request.filter,
      types: [...new Set([request.schema, ...(request.filter.types ?? [])])],
    },
    relations,
    sort,
    limit: request.limit,
    offset: request.offset,
  };
  let normalized: ReturnType<typeof parseSummaryRequest>;
  try {
    normalized = parseSummaryRequest(summaryRequest);
    validateSummaryRequest(db, normalized);
  } catch (e) {
    throw new RollupError(
      'INVALID_PARAMS',
      e instanceof Error ? e.message : 'Invalid compiled query.',
      {
        rollups: request.rollups,
        relations: request.relations.map((r) => r.name),
      },
    );
  }
  return {
    request: { ...request, filter: normalized.filter },
    summaryRequest: normalized,
    discovery,
    aliases,
  };
}
export function publicRollupDetails(
  compiled: CompiledRollups,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...details };
  if (typeof details.relation === 'string') {
    const names = [...compiled.aliases.rollups]
      .filter(
        ([, a]) =>
          a.relation === details.relation &&
          (details.metric === undefined || a.metric === details.metric),
      )
      .map(([n]) => n);
    const relationNames = [...compiled.aliases.relations]
      .filter(([, a]) => a === details.relation)
      .map(([n]) => n);
    delete result.relation;
    delete result.metric;
    if (names.length) result.rollups = names;
    if (relationNames.length) result.relation = relationNames[0];
    if (relationNames.length > 1) result.relations = relationNames;
  }
  return result;
}
