import type {
  EvaluationContext, EvaluationContextInput, PercentageDetails,
  SummaryFilter, SummaryFieldsFilter,
  SummaryIdentity,
  SummaryLookup,
  SummaryScalar,
  SummaryLookupDefinition,
} from '../summaries/types.js';
export interface SavedRelation {
  name: string;
  direction: 'incoming' | 'outgoing';
  field: string;
  filter?: Pick<SummaryFilter, 'types' | 'without_types'>;
  label?: string;
  description?: string;
}
export interface SavedRollup {
  name: string;
  relation: string;
  filter?: SummaryFieldsFilter;
  metric:
    | { op: 'percentage'; matching_filter: SummaryFieldsFilter }
    | { op: 'count' }
    | { op: 'min' | 'max'; field: string; date_mode?: 'calendar_date' };
  label?: string;
  description?: string;
}
export interface RelationshipViews {
  version: 1;
  relations: SavedRelation[];
  rollups: SavedRollup[];
}
export interface RelationshipViewsDiscovery {
  schema: string;
  relationship_views_hash: string;
  state: 'absent' | 'valid' | 'invalid' | 'unsupported';
  error?: string;
  relations: Array<{
    definition: SavedRelation;
    state: 'valid' | 'invalid';
    error?: string;
  }>;
  rollups: Array<{
    definition: SavedRollup;
    state: 'valid' | 'invalid';
    error?: string;
    type?: 'integer' | 'number' | 'date';
    nullable?: boolean;
    unit?: 'percent';
    requires_evaluation_context?: boolean;
  }>;
}
export interface ReadRollupsRequest {
  evaluation_context?: EvaluationContextInput;
  schema: string;
  rollups?: string[];
  relations?: Array<{ name: string; fields?: string[]; limit?: number }>;
  filter?: SummaryFilter;
  sort?:
    | { by: 'id' | 'title'; order: 'asc' | 'desc' }
    | { by: 'rollup'; name: string; order: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}
export interface ReadRollupsData {
  classification_dependencies?: import('../classification/types.js').ClassificationDependency[];
  evaluation_context?: EvaluationContext;
  kind: 'node_rollups';
  version: 1;
  schema: string;
  relationship_views_hash: string;
  definitions: {
    rollups: RelationshipViewsDiscovery['rollups'];
    relations: Array<{
      definition: SavedRelation;
      lookup: SummaryLookupDefinition;
    }>;
  };
  rows: Array<{
    node: SummaryIdentity;
    rollups: Record<string, SummaryScalar>;
    rollup_details?: Record<string, PercentageDetails>;
    relations: Record<string, SummaryLookup>;
  }>;
  page: {
    total: number;
    returned: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}
