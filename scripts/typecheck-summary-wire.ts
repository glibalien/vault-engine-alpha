// Type-only conformance: no deployable surface imports another surface.
import type { SummaryRequest as EngineRequest, SummaryData as EngineData } from '../packages/engine/src/summaries/types.js';
import type { SummaryRequest as QueryRequest, SummaryData as QueryData } from '../packages/query-core/src/summary-types.js';
import type { SummaryRequest as CuratorRequest, SummaryData as CuratorData } from '../packages/curator/src/summary-types.js';
type Assert<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type RequestsMatch = Assert<Assignable<EngineRequest, QueryRequest>>;
type RequestsMatchBack = Assert<Assignable<QueryRequest, EngineRequest>>;
type CuratorRequestsMatch = Assert<Assignable<EngineRequest, CuratorRequest>>;
type CuratorRequestsMatchBack = Assert<Assignable<CuratorRequest, EngineRequest>>;
type ResultsMatch = Assert<Assignable<EngineData, QueryData>>;
type ResultsMatchBack = Assert<Assignable<QueryData, EngineData>>;
type CuratorResultsMatch = Assert<Assignable<EngineData, CuratorData>>;
type CuratorResultsMatchBack = Assert<Assignable<CuratorData, EngineData>>;
// @ts-expect-error Summaries are versioned independently of editable node queries.
const invalidVersion: EngineData['version'] = 2;
// @ts-expect-error No recursive relation traversal in this slice.
const invalidDirection: QueryRequest['relations'][number]['direction'] = 'both';
// @ts-expect-error No sum or arbitrary expressions in this slice.
const invalidMetric: NonNullable<CuratorRequest['relations'][number]['metrics']>[number] = { as: 's', op: 'sum', field: 'estimate' };

const percentageMetric: NonNullable<QueryRequest['relations'][number]['metrics']>[number] = {as:'p',op:'percentage',matching_filter:{fields:{state:{eq:'resolved'}}}};
const relativeRequest: QueryRequest = {evaluation_context:{time_zone:'UTC'},relations:[{as:'r',field:'project',direction:'incoming',filter:{fields:{due:{date_window:{to_days:0}}}},metrics:[percentageMetric]}]};
// @ts-expect-error Supplied context always requires an explicit timezone.
const missingZone: QueryRequest['evaluation_context'] = {as_of:'2026-09-19T00:00:00Z'};
// @ts-expect-error Matching filters are fields-only.
const wrongMatching: NonNullable<QueryRequest['relations'][number]['metrics']>[number] = {as:'p',op:'percentage',matching_filter:{types:['task']}};
const details: NonNullable<QueryData['rows'][number]['relations'][string]['metric_details']>[string] = {numerator_count:2,denominator_count:4};

const booleanSummary: QueryRequest = {filter:{where:{any:[{types:['project']},{title_eq:'A'}]}},relations:[{as:'tasks',direction:'incoming',field:'project',filter:{where:{all:[{types:['task']},{fields:{status:{ne:'cancelled'}}}]}},metrics:[{as:'pct',op:'percentage',matching_filter:{where:{any:[{fields:{status:{eq:'done'}}},{fields:{due:{date_window:{to_days:0}}}}]}}}]}]};
const booleanForEngine:EngineRequest=booleanSummary;
const booleanForCurator:CuratorRequest=booleanSummary;
// @ts-expect-error Types remain unsupported inside fields-only matching expression leaves.
const invalidBooleanMatching: NonNullable<QueryRequest['relations'][number]['metrics']>[number]={as:'pct',op:'percentage',matching_filter:{where:{types:['task']}}};
