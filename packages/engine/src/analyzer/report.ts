export type AnalyzerRefusalCode =
  | 'INVALID_ROOT'
  | 'ROOT_UNREADABLE'
  | 'NO_MARKDOWN_FILES'
  | 'TYPE_FIELD_NOT_FOUND'
  | 'TYPE_FIELD_TARGET_COLLISION'
  | 'TYPE_KEY_RESERVED'
  | 'TYPE_KEY_VALUE_UNSUPPORTED'
  | 'NO_USABLE_TYPE_VALUES';

export type AnalyzerIssueCode =
  | 'FRONTMATTER_MALFORMED'
  | 'FILE_UNREADABLE'
  | 'TYPE_KEY_INCOMPLETE_COVERAGE'
  | 'TYPE_VALUE_INVALID'
  | 'TYPE_NAME_COLLISION'
  | 'FOLDER_RULE_UNMATCHED'
  | 'REFERENCE_UNRESOLVED'
  | 'REFERENCE_AMBIGUOUS'
  | 'FIELD_SHAPE_AMBIGUOUS'
  | 'CLAIM_OWNERSHIP_AMBIGUOUS';

export const ANALYZER_VERSION = '2.1.0' as const;
export const ANALYZER_FORMAT_VERSION = 2 as const;

export type AnalyzerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: AnalyzerRefusalCode | 'INVALID_ARGUMENTS';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export interface AnalyzerIssue {
  code: AnalyzerIssueCode;
  count: number;
  examples: Array<{ path?: string; field?: string; value?: unknown; message: string }>;
  truncated: boolean;
}

export interface AnalyzerInventory {
  total_files: number;
  markdown_files: number;
  non_markdown_by_extension: Record<string, number>;
  excluded_entries: Record<'directories' | 'symlinks', number>;
}

export interface TypeFieldCandidate {
  key: string;
  documents_with_key: number;
  valid_occurrences: number;
  invalid_occurrences: number;
  markdown_coverage: number;
  valid_shape_ratio: number;
  distinct_values: number;
  repeated_value_ratio: number;
  sample_values: string[];
  conventional_name: boolean;
}

/** A directory holding eligible Markdown, directly or in its subdirectories. */
export interface AnalyzerFolder {
  path: string;
  markdown_files: number;
  subtree_markdown_files: number;
}

export interface TypeFieldCandidateReportV2 {
  format_version: 2;
  analyzer_version: string;
  source: { canonical_root: string; source_fingerprint: string; exclusions: string[] };
  inventory: AnalyzerInventory;
  folders: AnalyzerFolder[];
  folders_truncated: boolean;
  candidates: TypeFieldCandidate[];
  candidates_truncated: boolean;
  /** Tags on every readable note, to offer as kinds before anything else types them (#650). */
  tags: TagCandidates;
  issues: AnalyzerIssue[];
}

export type AnalyzerFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'boolean'
  | 'reference'
  | 'enum'
  | 'list';

export interface FieldEvidence {
  observations: number;
  null_or_missing: number;
  distinct_values: number;
  shape_distribution: Record<string, number>;
  sample_values: unknown[];
  samples_truncated: boolean;
  reference?: {
    resolved_targets: number;
    unresolved_targets: number;
    ambiguous_targets: number;
    target_type_distribution: Record<string, number>;
  };
}

export interface ProposedGlobalField {
  name: string;
  field_type: AnalyzerFieldType;
  list_item_type?: Exclude<AnalyzerFieldType, 'list'>;
  enum_values?: string[];
  reference_target?: string;
  required: false;
  status: 'apply_ready';
  evidence: FieldEvidence;
}

/** A type a caller chooses for a field instead of the inferred one. */
export interface FieldTypeChoice {
  field_type: Exclude<AnalyzerFieldType, 'enum'>;
  /** Required for, and only for, `list`. */
  list_item_type?: Exclude<AnalyzerFieldType, 'list' | 'enum'>;
}

/**
 * A type a field that needs review could be stored as: `text` stores every value as a
 * string, and `dominant` is the most common value shape. `unconverted` counts the values
 * Engine's coercion would refuse for it; 0 means every value converts.
 */
export interface FieldTypeOption extends FieldTypeChoice {
  option: 'text' | 'dominant';
  unconverted: number;
}

export interface AmbiguousGlobalField {
  name: string;
  status: 'needs_review';
  reasons: string[];
  evidence: FieldEvidence;
  options: FieldTypeOption[];
}

export interface ProposedFieldClaim {
  field: string;
  effective_required: false;
  evidence: {
    single_type_documents: number;
    all_typed_documents: number;
    coverage: number;
  };
}

export interface ProposedSchema {
  name: string;
  default_directory?: string;
  field_claims: ProposedFieldClaim[];
  evidence: {
    typed_documents: number;
    single_type_documents: number;
    parent_directories: Record<string, number>;
  };
}

export interface AmbiguousClaim {
  field: string;
  candidate_types: string[];
  multi_type_documents: number;
  status: 'needs_review';
}

/** How many documents carry one normalized type-field value, and the type it becomes. */
export interface TypeFieldValueAssignment {
  value: string;
  type: string | null;
  documents: number;
}

/**
 * One caller folder rule. `markdown_files` counts the Markdown files for which it is
 * the deepest matching rule; `documents` counts the files it actually typed.
 */
export interface FolderRuleAssignment {
  directory: string;
  type: string | null;
  markdown_files: number;
  documents: number;
}

/** A tag rule and the documents it typed (#650). */
export interface TagRuleAssignment {
  tag: string;
  type: string | null;
  /** Documents the tag gave a type: none typed by the type field. */
  documents: number;
}

/** Tags offered as kinds: on notes the type field does not type, the most used first (#650). */
export interface TagCandidates {
  candidates: Array<{ tag: string; documents: number }>;
  truncated: boolean;
}

/**
 * One eligible Markdown file and the final types the assignment gives it: empty when it
 * stays untyped, has unreadable or malformed frontmatter, or lost a withheld name.
 */
export interface FileTypeAssignment {
  path: string;
  types: string[];
}

/** Distinct type names that would share one portable schema filename. */
export interface TypeNameCollision {
  names: string[];
  documents: number;
}

export interface AnalyzerReportV2 {
  format_version: 2;
  analyzer_version: string;
  source: {
    canonical_root: string;
    confirmed_type_field: string | null;
    source_fingerprint: string;
    exclusions: string[];
  };
  inventory: AnalyzerInventory;
  coverage: {
    files_with_frontmatter: number;
    typed_files: number;
    untyped_files: number;
    malformed_frontmatter_files: number;
    usable_percentage: number;
    typed_by_type_field: number;
    typed_by_folder_rule: number;
    typed_by_tag_rule: number;
  };
  proposal: {
    /** The type field mapped onto the key Engine keeps types in (`types` unless designated). */
    type_field_mapping: { source: string; target: string } | null;
    type_assignment: {
      type_field_values: TypeFieldValueAssignment[];
      folder_rules: FolderRuleAssignment[];
      tag_rules: TagRuleAssignment[];
      type_renames: Array<{ from: string; to: string | null }>;
      /** Every eligible Markdown file in path order; what adoption applies. */
      files: FileTypeAssignment[];
    };
    global_fields: ProposedGlobalField[];
    schemas: ProposedSchema[];
  };
  needs_review: {
    ambiguous_fields: AmbiguousGlobalField[];
    ambiguous_claims: AmbiguousClaim[];
    type_name_collisions: TypeNameCollision[];
  };
  /** Tags on the notes the type field does not type, to offer as kinds (#650). */
  tags: TagCandidates;
  issues: AnalyzerIssue[];
}

export function refusal(
  code: AnalyzerRefusalCode,
  message: string,
  details?: Record<string, unknown>,
): AnalyzerResult<never> {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}

export function invalidArguments(message: string): AnalyzerResult<never> {
  return { ok: false, error: { code: 'INVALID_ARGUMENTS', message } };
}
