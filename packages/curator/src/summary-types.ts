import type { ClassificationDependency } from './classification-types.js';
export type FilterExpression<L> = L | {all:FilterExpression<L>[]} | {any:FilterExpression<L>[]};
export interface EvaluationContextInput { time_zone: string; as_of?: string }
export interface EvaluationContext { time_zone: string; as_of: string; calendar_date: string }
export interface DateWindow { from_days?: number; to_days?: number }
export interface PercentageDetails { numerator_count: number; denominator_count: number }
/** Read-only summary wire contract. Clients mirror this without workspace imports. */
export type SummaryScalar = string | number | boolean | null;
export type SummaryPredicate = {in_group:{schema:string;group:string}} | {is_unclassified:{schema:string}} | { date_window: DateWindow } | {
    eq: string | number;
} | {
    ne: string | number;
} | {
    gt: number;
} | {
    gte: number;
} | {
    lt: number;
} | {
    lte: number;
} | {
    one_of: string[] | number[];
} | {
    includes: string | number;
} | {
    exists: boolean;
};
export interface SummaryFilterLeaf {
    node_ids?: string[];
    without_node_ids?: string[];
    types?: string[];
    without_types?: string[];
    fields?: Record<string, SummaryPredicate>;
    title_eq?: string;
    title_contains?: string;
    path_prefix?: string;
}
export interface SummaryFilter extends SummaryFilterLeaf { where?: FilterExpression<SummaryFilterLeaf> }
export interface SummaryFieldsFilter { fields?: Record<string, SummaryPredicate>; where?: FilterExpression<Pick<SummaryFilterLeaf, 'fields'>> }
export type SummaryMetric = {
    as: string; op: 'percentage'; matching_filter: SummaryFieldsFilter;
} | {
    as: string;
    op: 'count';
} | {
    as: string;
    op: 'min' | 'max';
    field: string;
    date_mode?: 'calendar_date';
};
export interface SummaryRelation {
    as: string;
    direction: 'incoming' | 'outgoing';
    field: string;
    filter?: SummaryFilter;
    metrics?: SummaryMetric[];
    lookup?: {
        fields?: string[];
        limit?: number;
    };
}
export type SummarySort = {
    by: 'id' | 'title';
    order: 'asc' | 'desc';
} | {
    by: 'metric';
    relation: string;
    metric: string;
    order: 'asc' | 'desc';
};
export interface SummaryRequest {
    evaluation_context?: EvaluationContextInput;
    filter?: SummaryFilter;
    relations: SummaryRelation[];
    sort?: SummarySort;
    limit?: number;
    offset?: number;
}
export interface SummaryIdentity {
    id: string;
    title: string | null;
    file_path: string;
    version: number;
}
export type SummaryMetricDefinition = {
    as: string; op: 'percentage'; matching_filter: SummaryFieldsFilter;
    type: 'number'; nullable: true; unit: 'percent';
} | {
    as: string;
    op: 'count';
    type: 'integer';
    nullable: false;
} | {
    as: string;
    op: 'min' | 'max';
    field: string;
    type: 'number' | 'date';
    nullable: true;
    date_mode?: 'calendar_date';
};
export interface SummaryLookupDefinition {
    fields: Array<{
        name: string;
        type: 'string' | 'enum' | 'number' | 'boolean' | 'date';
    }>;
    limit: number;
}
export interface SummaryDefinition {
    as: string;
    direction: 'incoming' | 'outgoing';
    field: string;
    filter: SummaryFilter;
    metrics: SummaryMetricDefinition[];
    lookup?: SummaryLookupDefinition;
}
export interface SummaryLookup {
    items: Array<SummaryIdentity & {
        fields: Record<string, SummaryScalar>;
    }>;
    total: number;
    returned: number;
    truncated: boolean;
}
export interface SummaryRow {
    node: SummaryIdentity;
    relations: Record<string, {
        metrics: Record<string, number | string | null>;
        metric_details?: Record<string, PercentageDetails>;
        lookup?: SummaryLookup;
    }>;
}
export interface SummaryData {
  classification_dependencies?: ClassificationDependency[];
    evaluation_context?: EvaluationContext;
    kind: 'node_summaries';
    version: 1;
    definitions: SummaryDefinition[];
    rows: SummaryRow[];
    page: {
        total: number;
        returned: number;
        limit: number;
        offset: number;
        has_more: boolean;
    };
}
