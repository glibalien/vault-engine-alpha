// Type-only conformance: no deployable surface imports another surface.
import type {
  TraversalRequest as EngineRequest,
  TraversalData as EngineData,
} from '../packages/engine/src/traversal/types.js';
import type {
  TraversalRequest as QueryRequest,
  TraversalData as QueryData,
} from '../packages/query-core/src/traversal-types.js';
import type {
  TraversalRequest as CuratorRequest,
  TraversalData as CuratorData,
} from '../packages/curator/src/traversal-types.js';
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
