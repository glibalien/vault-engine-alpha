// Type-only conformance: no deployable surface imports another surface.
import type {
  ReadRollupsRequest as EngineRequest,
  ReadRollupsData as EngineData,
} from '../packages/engine/src/rollups/types.js';
import type {
  ReadRollupsRequest as QueryRequest,
  ReadRollupsData as QueryData,
} from '../packages/query-core/src/rollup-types.js';
import type {
  ReadRollupsRequest as CuratorRequest,
  ReadRollupsData as CuratorData,
} from '../packages/curator/src/rollup-types.js';
type Assert<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type RequestsMatch = Assert<Assignable<EngineRequest, QueryRequest>>;
type RequestsMatchBack = Assert<Assignable<QueryRequest, EngineRequest>>;
type CuratorRequestsMatch = Assert<Assignable<EngineRequest, CuratorRequest>>;
type CuratorRequestsMatchBack = Assert<
  Assignable<CuratorRequest, EngineRequest>
>;
type ResultsMatch = Assert<Assignable<EngineData, QueryData>>;
type ResultsMatchBack = Assert<Assignable<QueryData, EngineData>>;
type CuratorResultsMatch = Assert<Assignable<EngineData, CuratorData>>;
type CuratorResultsMatchBack = Assert<Assignable<CuratorData, EngineData>>;

import type { RelationshipViewsDiscovery as EngineDiscovery } from '../packages/engine/src/rollups/types.js';
import type { RelationshipViewsDiscovery as QueryDiscovery } from '../packages/query-core/src/rollup-types.js';
import type { RelationshipViewsDiscovery as CuratorDiscovery } from '../packages/curator/src/rollup-types.js';
type DiscoveryForward = Assert<Assignable<EngineDiscovery, QueryDiscovery>>;
type DiscoveryBack = Assert<Assignable<QueryDiscovery, EngineDiscovery>>;
type CuratorDiscoveryForward = Assert<
  Assignable<EngineDiscovery, CuratorDiscovery>
>;
type CuratorDiscoveryBack = Assert<
  Assignable<CuratorDiscovery, EngineDiscovery>
>;
const booleanRollupRequest:QueryRequest={schema:'project',rollups:['completion'],filter:{where:{any:[{title_eq:'A'},{node_ids:['p1']}]}}};
const booleanRollupEngine:EngineRequest=booleanRollupRequest;
const booleanRollupCurator:CuratorRequest=booleanRollupRequest;
