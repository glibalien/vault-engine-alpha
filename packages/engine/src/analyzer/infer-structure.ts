import { posix } from 'node:path';
import type { YamlValue } from '../parser/types.js';
import { engineFieldValue, inferFieldDefinition } from './field-inference.js';
import { buildReferenceIndex, resolveReference } from './reference-index.js';
import type { ScanSnapshot, ScannedMarkdownFile } from './scan.js';
import {
  matchFolderRule,
  readTypeFieldValues,
  tagRuleTypes,
  type TypeAssignmentPlan,
} from './type-assignment.js';
import { tagCandidates } from './tags.js';
import {
  ANALYZER_FORMAT_VERSION,
  ANALYZER_VERSION,
  refusal,
  type AmbiguousClaim,
  type AnalyzerIssue,
  type AnalyzerIssueCode,
  type AnalyzerReportV2,
  type AnalyzerResult,
  type FieldTypeChoice,
  type FileTypeAssignment,
  type ProposedGlobalField,
  type ProposedSchema,
  type TypeNameCollision,
} from './report.js';
import { portableSchemaNameKey } from './schema-name.js';
import { unkeptTypeKeyValues } from '../parser/frontmatter.js';

const MAX_ISSUE_EXAMPLES = 10;

interface TypedDocument {
  path: string;
  parentDirectory: string;
  /** Proposed types; colliding names are withheld. */
  types: string[];
  /**
   * Every type the assignment gave the document, before collisions were withheld.
   * Single- versus multi-type ownership is judged on this, so withholding an
   * unresolved name never turns a multi-type document into single-type evidence.
   */
  assignedTypes: string[];
  /** Directory of the folder rule that typed this document, or null when typed by the type field or tags. */
  folderRule: string | null;
  /** What typed it. */
  source: 'type_field' | 'tag_rule' | 'folder_rule';
  fields: Map<string, YamlValue>;
}

interface ParsedDocument {
  file: ScannedMarkdownFile;
  types: string[];
  assignedTypes: string[];
  source: 'type_field' | 'tag_rule' | 'folder_rule' | null;
  folderRule: string | null;
  /** The tag rules that typed it. */
  tagRules: string[];
  fields: Map<string, YamlValue>;
}

type IssueExample = AnalyzerIssue['examples'][number];

export function readConfirmedTypes(
  file: ScannedMarkdownFile,
  typeField: string,
): { types: string[]; invalidValues: unknown[]; keyPresent: boolean } {
  const { types, invalidValues, keyPresent } = readTypeFieldValues(file, typeField, new Map());
  return { types, invalidValues, keyPresent };
}

export function buildAnalyzerReport(
  snapshot: ScanSnapshot,
  plan: TypeAssignmentPlan,
  fieldTypes: ReadonlyMap<string, FieldTypeChoice> = new Map(),
): AnalyzerResult<AnalyzerReportV2> {
  const { typeField, typeKey } = plan;
  const issues = new IssueCollector(snapshot.issues);
  const parsedDocuments: ParsedDocument[] = [];
  const targetCollisions: string[] = [];
  /** Files whose type key holds a value Engine could not keep as a type. */
  const unkeptValues: string[] = [];
  const valueCounts = new Map<string, number>();
  const ruleMarkdownFiles = new Map(plan.folderRules.map(rule => [rule.directory, 0]));
  /** The tags of each readable document the type field leaves untyped: what is offered as kinds. */
  const untypedByField: string[][] = [];
  let keyOccurrences = 0;

  for (const file of snapshot.files) {
    const rule = matchFolderRule(plan.folderRules, file.relativePath);
    if (rule) ruleMarkdownFiles.set(rule.directory, (ruleMarkdownFiles.get(rule.directory) ?? 0) + 1);
    if (!isParseable(file)) continue;

    let types: string[] = [];
    let source: ParsedDocument['source'] = null;
    if (typeField !== null) {
      const read = readTypeFieldValues(file, typeField, plan.typeRenames);
      if (read.keyPresent) keyOccurrences++;
      for (const invalidValue of read.invalidValues) {
        issues.add('TYPE_VALUE_INVALID', {
          path: file.relativePath,
          field: typeField,
          value: invalidValue,
          message: 'Confirmed type field contains an unusable value',
        });
      }
      for (const value of read.values) valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
      if (read.types.length > 0) {
        types = read.types;
        source = 'type_field';
      }
    }
    // A tag the note carries says more about it than the folder it sits in (#650).
    let byTags: string[] = [];
    if (source === null) {
      const tagged = tagRuleTypes(plan.tagRules, file.tags);
      if (tagged.types.length > 0) {
        types = tagged.types;
        byTags = tagged.tags;
        source = 'tag_rule';
      }
    }
    if (source === null && rule?.type) {
      types = [rule.type];
      source = 'folder_rule';
    }
    if (source !== 'type_field') untypedByField.push(file.tags);

    if (
      Object.prototype.hasOwnProperty.call(file.frontmatter.data, typeKey)
      && unkeptTypeKeyValues(file.frontmatter.data[typeKey] as YamlValue).length > 0
    ) {
      unkeptValues.push(file.relativePath);
    }
    if (typeField !== typeKey && hasTypeKeyConflict(file, source, typeKey)) {
      targetCollisions.push(file.relativePath);
    }
    parsedDocuments.push({
      file,
      types,
      assignedTypes: [...types],
      source,
      folderRule: source === 'folder_rule' && rule ? rule.directory : null,
      tagRules: byTags,
      fields: new Map(
        Object.entries(file.frontmatter.data)
          .filter(([key]) => key !== typeField && key !== typeKey),
      ),
    });
  }

  if (typeField !== null && keyOccurrences === 0) {
    return refusal('TYPE_FIELD_NOT_FOUND', 'Confirmed type field was not found in parseable frontmatter', {
      type_field: typeField,
    });
  }

  if (unkeptValues.length > 0) {
    const files = unkeptValues.slice(0, MAX_ISSUE_EXAMPLES);
    return refusal(
      'TYPE_KEY_VALUE_UNSUPPORTED',
      `Engine could not keep every value of "${typeKey}" as note types: some notes hold a mapping or a nested list there, which the next save would drop. Change those values or choose another way to type notes`,
      { type_key: typeKey, files, files_truncated: unkeptValues.length > files.length },
    );
  }

  if (targetCollisions.length > 0) {
    const conflictingFiles = targetCollisions.slice(0, MAX_ISSUE_EXAMPLES);
    return refusal(
      'TYPE_FIELD_TARGET_COLLISION',
      plan.folderRules.length === 0
        ? `Confirmed type field cannot be mapped because typed documents already contain "${typeKey}"`
        : `Assigned types cannot be mapped to "${typeKey}" because typed documents already contain it`,
      {
        type_field: typeField,
        target_field: typeKey,
        conflicting_files: conflictingFiles,
        conflicts_truncated: targetCollisions.length > conflictingFiles.length,
      },
    );
  }

  if (!parsedDocuments.some(document => document.types.length > 0)) {
    return refusal(
      'NO_USABLE_TYPE_VALUES',
      plan.folderRules.length === 0
        ? 'Confirmed type field contains no usable type values'
        : 'Type assignment produces no typed documents',
      {
        type_field: typeField,
        occurrences: keyOccurrences,
        folder_rules: plan.folderRules.length,
      },
    );
  }

  const typeNameCollisions = withholdCollidingTypes(parsedDocuments, issues);
  const typedDocuments = parsedDocuments
    .filter(document => document.types.length > 0)
    .map(toTypedDocument);

  if (typeField !== null) {
    const typedByField = new Set(parsedDocuments
      .filter(document => document.source === 'type_field')
      .map(document => document.file.relativePath));
    for (const file of snapshot.files.filter(file => !typedByField.has(file.relativePath))) {
      issues.add('TYPE_KEY_INCOMPLETE_COVERAGE', {
        path: file.relativePath,
        field: typeField,
        message: 'File has no usable value for the confirmed type field',
      });
    }
  }

  const ruleDocuments = new Map<string, number>();
  for (const document of typedDocuments) {
    if (document.folderRule !== null) {
      ruleDocuments.set(document.folderRule, (ruleDocuments.get(document.folderRule) ?? 0) + 1);
    }
  }
  for (const rule of plan.folderRules) {
    if ((ruleMarkdownFiles.get(rule.directory) ?? 0) === 0) {
      issues.add('FOLDER_RULE_UNMATCHED', {
        path: rule.directory,
        message: 'Folder rule matches no eligible Markdown file',
      });
    }
  }

  const definitions = inferFields(typedDocuments, parsedDocuments, snapshot.files, fieldTypes, issues);
  const applyReadyNames = new Set(definitions.applyReady.map(field => field.name));
  const schemas = buildSchemas(typedDocuments, applyReadyNames);
  const ambiguousClaims = buildAmbiguousClaims(typedDocuments, applyReadyNames);
  for (const field of definitions.ambiguous) {
    issues.add('FIELD_SHAPE_AMBIGUOUS', {
      field: field.name,
      message: field.reasons.join('; '),
    });
  }
  for (const claim of ambiguousClaims) {
    issues.add('CLAIM_OWNERSHIP_AMBIGUOUS', {
      field: claim.field,
      message: `Field occurs only on multi-type documents: ${claim.candidate_types.join(', ')}`,
    });
  }

  const malformedFrontmatterFiles = snapshot.files.filter(file =>
    file.frontmatter?.parseError !== null && file.frontmatter?.parseError !== undefined).length;
  const filesWithFrontmatter = snapshot.files.filter(file =>
    file.frontmatter?.hasFrontmatter === true).length;

  return {
    ok: true,
    data: {
      format_version: ANALYZER_FORMAT_VERSION,
      analyzer_version: ANALYZER_VERSION,
      source: {
        canonical_root: snapshot.canonicalRoot,
        confirmed_type_field: typeField,
        source_fingerprint: snapshot.sourceFingerprint,
        exclusions: snapshot.exclusions,
      },
      inventory: snapshot.inventory,
      coverage: {
        files_with_frontmatter: filesWithFrontmatter,
        typed_files: typedDocuments.length,
        untyped_files: snapshot.inventory.markdown_files - typedDocuments.length,
        malformed_frontmatter_files: malformedFrontmatterFiles,
        usable_percentage: snapshot.inventory.markdown_files === 0
          ? 0
          : (typedDocuments.length / snapshot.inventory.markdown_files) * 100,
        typed_by_type_field: typedDocuments.filter(document => document.source === 'type_field').length,
        typed_by_folder_rule: typedDocuments.filter(document => document.source === 'folder_rule').length,
        typed_by_tag_rule: typedDocuments.filter(document => document.source === 'tag_rule').length,
      },
      proposal: {
        type_field_mapping: typeField === null ? null : { source: typeField, target: typeKey },
        type_assignment: {
          type_field_values: [...valueCounts.entries()]
            .sort(([left], [right]) => compareExact(left, right))
            .map(([value, documents]) => ({
              value,
              type: plan.typeRenames.has(value) ? plan.typeRenames.get(value) ?? null : value,
              documents,
            })),
          folder_rules: plan.folderRules.map(rule => ({
            directory: rule.directory,
            type: rule.type,
            markdown_files: ruleMarkdownFiles.get(rule.directory) ?? 0,
            documents: ruleDocuments.get(rule.directory) ?? 0,
          })),
          tag_rules: [...plan.tagRules].map(([tag, type]) => ({
            tag,
            type,
            documents: parsedDocuments.filter(document => document.types.length > 0 && document.tagRules.includes(tag)).length,
          })),
          type_renames: [...plan.typeRenames.entries()]
            .sort(([left], [right]) => compareExact(left, right))
            .map(([from, to]) => ({ from, to })),
          files: fileAssignments(snapshot.files, parsedDocuments),
        },
        global_fields: definitions.applyReady,
        schemas,
      },
      needs_review: {
        ambiguous_fields: definitions.ambiguous,
        ambiguous_claims: ambiguousClaims,
        type_name_collisions: typeNameCollisions,
      },
      tags: tagCandidates(untypedByField),
      issues: issues.finish(),
    },
  };
}

/**
 * A document typed by anything other than the type key Engine keeps types in (`types`
 * unless designated) must not already carry a value there: Engine indexes strings that
 * the Analyzer would reject as schema names (`_legacy`), and adoption re-renders the key
 * from the database, overwriting values Engine does not parse at all (an unquoted
 * `[[legacy]]`, numbers). An empty key holds nothing to overwrite; Engine writes one
 * (`types:`) on every note it saves, such as those its startup link repair rewrites
 * before adoption.
 */
function hasTypeKeyConflict(
  file: ScannedMarkdownFile & { frontmatter: NonNullable<ScannedMarkdownFile['frontmatter']> },
  source: ParsedDocument['source'],
  typeKey: string,
): boolean {
  const data = file.frontmatter.data;
  if (source === null || !Object.prototype.hasOwnProperty.call(data, typeKey)) return false;
  const value = data[typeKey];
  return !(value === null || value === '' || (Array.isArray(value) && value.length === 0));
}

/**
 * Remove every type name that shares a portable schema filename with another name,
 * so the proposal stays apply-safe. Each collision becomes a review item; documents
 * keep their other types.
 */
function withholdCollidingTypes(
  documents: ParsedDocument[],
  issues: IssueCollector,
): TypeNameCollision[] {
  const namesByPortableKey = new Map<string, Set<string>>();
  for (const document of documents) {
    for (const type of document.types) {
      const key = portableSchemaNameKey(type);
      const names = namesByPortableKey.get(key) ?? new Set<string>();
      names.add(type);
      namesByPortableKey.set(key, names);
    }
  }
  const groups = [...namesByPortableKey.values()]
    .map(names => [...names].sort(compareExact))
    .filter(names => names.length > 1)
    .sort((left, right) => compareExact(left[0], right[0]));
  if (groups.length === 0) return [];

  const colliding = new Set(groups.flat());
  const groupDocuments = new Map(groups.map(group => [group[0], 0]));
  for (const document of documents) {
    const withheld = document.types.filter(type => colliding.has(type)).sort(compareExact);
    if (withheld.length === 0) continue;
    for (const group of groups) {
      if (group.some(name => withheld.includes(name))) {
        groupDocuments.set(group[0], (groupDocuments.get(group[0]) ?? 0) + 1);
      }
    }
    issues.add('TYPE_NAME_COLLISION', {
      path: document.file.relativePath,
      value: withheld,
      message: 'Type names that differ only by case or Unicode form were withheld',
    });
    document.types = document.types.filter(type => !colliding.has(type));
  }
  return groups.map(names => ({ names, documents: groupDocuments.get(names[0]) ?? 0 }));
}

/** Each scanned file with its proposed types, after colliding names were withheld. */
function fileAssignments(
  files: readonly ScannedMarkdownFile[],
  documents: readonly ParsedDocument[],
): FileTypeAssignment[] {
  const typesByPath = new Map(documents.map(document => [document.file.relativePath, document.types]));
  return files
    .map(file => ({ path: file.relativePath, types: [...(typesByPath.get(file.relativePath) ?? [])] }))
    .sort((left, right) => compareExact(left.path, right.path));
}

function isParseable(file: ScannedMarkdownFile): file is ScannedMarkdownFile & {
  frontmatter: NonNullable<ScannedMarkdownFile['frontmatter']>;
} {
  return !file.unreadable && file.frontmatter !== null && file.frontmatter.parseError === null;
}

function toTypedDocument(document: ParsedDocument): TypedDocument {
  return {
    path: document.file.relativePath,
    parentDirectory: parentDirectory(document.file.relativePath),
    types: document.types,
    assignedTypes: document.assignedTypes,
    folderRule: document.folderRule,
    // Only typed documents become TypedDocuments, so a source is set.
    source: document.source ?? 'type_field',
    fields: document.fields,
  };
}

function parentDirectory(relativePath: string): string {
  const parent = posix.dirname(relativePath);
  return parent === '' ? '.' : parent;
}

function inferFields(
  documents: TypedDocument[],
  parsedDocuments: ParsedDocument[],
  scannedFiles: ScannedMarkdownFile[],
  fieldTypes: ReadonlyMap<string, FieldTypeChoice>,
  issues: IssueCollector,
): {
  applyReady: AnalyzerReportV2['proposal']['global_fields'];
  ambiguous: AnalyzerReportV2['needs_review']['ambiguous_fields'];
} {
  const fieldNames = new Set<string>();
  for (const document of documents) {
    for (const field of document.fields.keys()) fieldNames.add(field);
  }
  const typesByPath = new Map(parsedDocuments.map(document => [
    document.file.relativePath,
    document.types,
  ]));
  const referenceIndex = buildReferenceIndex(scannedFiles.map(file => ({
    relativePath: file.relativePath,
    title: file.title,
    types: typesByPath.get(file.relativePath) ?? [],
  })));
  const applyReady: AnalyzerReportV2['proposal']['global_fields'] = [];
  const ambiguous: AnalyzerReportV2['needs_review']['ambiguous_fields'] = [];

  for (const fieldName of [...fieldNames].sort(compareExact)) {
    const observations = documents.map(document => document.fields.get(fieldName) ?? null);
    const inferred = inferFieldDefinition(fieldName, observations, fieldTypes.get(fieldName));
    if (inferred.status === 'needs_review') {
      ambiguous.push(inferred);
      continue;
    }
    if (isReferenceField(inferred)) {
      addReferenceEvidence(inferred, fieldName, documents, referenceIndex, issues);
    }
    applyReady.push(inferred);
  }
  return { applyReady, ambiguous };
}

function isReferenceField(field: ProposedGlobalField): boolean {
  return field.field_type === 'reference'
    || (field.field_type === 'list' && field.list_item_type === 'reference');
}

function addReferenceEvidence(
  field: ProposedGlobalField,
  fieldName: string,
  documents: TypedDocument[],
  referenceIndex: ReturnType<typeof buildReferenceIndex>,
  issues: IssueCollector,
): void {
  const typeCounts = new Map<string, number>();
  const resolvedTypeSets: string[][] = [];
  let targetCount = 0;
  let unresolvedTargets = 0;
  let ambiguousTargets = 0;

  for (const document of documents) {
    if (!document.fields.has(fieldName)) continue;
    for (const target of referenceTargets(document.fields.get(fieldName) as YamlValue, field)) {
      targetCount++;
      const resolution = resolveReference(referenceIndex, target);
      if (resolution.status === 'unresolved') {
        unresolvedTargets++;
        issues.add('REFERENCE_UNRESOLVED', {
          path: document.path,
          field: fieldName,
          value: target,
          message: 'Reference target could not be resolved',
        });
        continue;
      }
      if (resolution.status === 'ambiguous') {
        ambiguousTargets++;
        issues.add('REFERENCE_AMBIGUOUS', {
          path: document.path,
          field: fieldName,
          value: target,
          message: 'Reference target matches multiple files',
        });
        continue;
      }
      resolvedTypeSets.push(resolution.types);
      for (const type of resolution.types) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
  }

  field.evidence.reference = {
    resolved_targets: resolvedTypeSets.length,
    unresolved_targets: unresolvedTargets,
    ambiguous_targets: ambiguousTargets,
    target_type_distribution: sortedCountRecord(typeCounts),
  };

  if (targetCount === 0 || unresolvedTargets > 0 || ambiguousTargets > 0) return;
  const sharedTypes = intersectTypeSets(resolvedTypeSets);
  if (sharedTypes.length === 1) field.reference_target = sharedTypes[0];
}

/**
 * The targets Engine would store for a reference field's value. A chosen reference type
 * also accepts plain names, so they count as targets too.
 */
function referenceTargets(value: YamlValue, field: ProposedGlobalField): string[] {
  const type = { field_type: field.field_type, ...(field.list_item_type ? { list_item_type: field.list_item_type } : {}) };
  const stored = engineFieldValue(value, type as FieldTypeChoice);
  if (!stored.ok) return [];
  const targets = Array.isArray(stored.value) ? stored.value : [stored.value];
  return targets.filter((target): target is string => typeof target === 'string' && target.length > 0);
}

function intersectTypeSets(typeSets: string[][]): string[] {
  if (typeSets.length === 0) return [];
  let intersection = new Set(typeSets[0]);
  for (const types of typeSets.slice(1)) {
    const current = new Set(types);
    intersection = new Set([...intersection].filter(type => current.has(type)));
  }
  return [...intersection].sort(compareExact);
}

function buildSchemas(
  documents: TypedDocument[],
  applyReadyNames: Set<string>,
): ProposedSchema[] {
  const typeNames = new Set(documents.flatMap(document => document.types));
  return [...typeNames].sort(compareExact).map(name => {
    const allTypeDocuments = documents.filter(document => document.types.includes(name));
    const singleTypeDocuments = allTypeDocuments.filter(document => document.assignedTypes.length === 1);
    const parentCounts = new Map<string, number>();
    for (const document of singleTypeDocuments) {
      parentCounts.set(document.parentDirectory, (parentCounts.get(document.parentDirectory) ?? 0) + 1);
    }
    const claimNames = new Set<string>();
    for (const document of singleTypeDocuments) {
      for (const field of document.fields.keys()) {
        if (applyReadyNames.has(field)) claimNames.add(field);
      }
    }
    const fieldClaims = [...claimNames].sort(compareExact).map(field => {
      const singleTypeObservations = singleTypeDocuments.filter(document => document.fields.has(field)).length;
      const allTypedObservations = allTypeDocuments.filter(document => document.fields.has(field)).length;
      return {
        field,
        effective_required: false as const,
        evidence: {
          single_type_documents: singleTypeObservations,
          all_typed_documents: allTypedObservations,
          coverage: allTypeDocuments.length === 0 ? 0 : allTypedObservations / allTypeDocuments.length,
        },
      };
    });
    const defaultDirectory = sharedFolderRule(singleTypeDocuments)
      ?? (singleTypeDocuments.length > 0 && parentCounts.size === 1
        ? parentCounts.keys().next().value as string
        : null);
    return {
      name,
      ...(defaultDirectory !== null ? { default_directory: defaultDirectory } : {}),
      field_claims: fieldClaims,
      evidence: {
        typed_documents: allTypeDocuments.length,
        single_type_documents: singleTypeDocuments.length,
        parent_directories: sortedCountRecord(parentCounts),
      },
    };
  });
}

/** The one folder rule that typed every given document, or null. */
function sharedFolderRule(documents: TypedDocument[]): string | null {
  const first = documents[0]?.folderRule ?? null;
  if (first === null) return null;
  return documents.every(document => document.folderRule === first) ? first : null;
}

function buildAmbiguousClaims(
  documents: TypedDocument[],
  applyReadyNames: Set<string>,
): AmbiguousClaim[] {
  const singleTypeOwners = new Map<string, Set<string>>();
  for (const document of documents.filter(document => document.assignedTypes.length === 1)) {
    for (const field of document.fields.keys()) {
      if (!applyReadyNames.has(field)) continue;
      const owners = singleTypeOwners.get(field) ?? new Set<string>();
      owners.add(document.types[0]);
      singleTypeOwners.set(field, owners);
    }
  }

  const multiTypeEvidence = new Map<string, { types: Set<string>; documents: number }>();
  for (const document of documents.filter(document => document.assignedTypes.length > 1)) {
    for (const field of document.fields.keys()) {
      if (!applyReadyNames.has(field) || (singleTypeOwners.get(field)?.size ?? 0) > 0) continue;
      const evidence = multiTypeEvidence.get(field) ?? { types: new Set<string>(), documents: 0 };
      for (const type of document.assignedTypes) evidence.types.add(type);
      evidence.documents++;
      multiTypeEvidence.set(field, evidence);
    }
  }

  return [...multiTypeEvidence.entries()]
    .sort(([left], [right]) => compareExact(left, right))
    .map(([field, evidence]) => ({
      field,
      candidate_types: [...evidence.types].sort(compareExact),
      multi_type_documents: evidence.documents,
      status: 'needs_review',
    }));
}

function sortedCountRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => compareExact(left, right)));
}

export class IssueCollector {
  private readonly issues = new Map<AnalyzerIssueCode, {
    count: number;
    examples: IssueExample[];
    truncated: boolean;
  }>();

  constructor(initial: AnalyzerIssue[]) {
    for (const issue of initial) {
      const sortedExamples = issue.examples.slice().sort(compareIssueExamples);
      const examples = sortedExamples.slice(0, MAX_ISSUE_EXAMPLES);
      this.issues.set(issue.code, {
        count: issue.count,
        examples,
        truncated: issue.truncated
          || issue.count > examples.length
          || sortedExamples.length > MAX_ISSUE_EXAMPLES,
      });
    }
  }

  add(code: AnalyzerIssueCode, example: IssueExample): void {
    const issue = this.issues.get(code);
    if (issue) {
      issue.count++;
      if (issue.examples.length < MAX_ISSUE_EXAMPLES) {
        issue.examples.push(example);
        issue.examples.sort(compareIssueExamples);
      } else {
        issue.truncated = true;
        const largestRetained = issue.examples[issue.examples.length - 1];
        if (compareIssueExamples(example, largestRetained) < 0) {
          issue.examples[issue.examples.length - 1] = example;
          issue.examples.sort(compareIssueExamples);
        }
      }
    } else {
      this.issues.set(code, { count: 1, examples: [example], truncated: false });
    }
  }

  retainedExampleCount(code: AnalyzerIssueCode): number {
    return this.issues.get(code)?.examples.length ?? 0;
  }

  finish(): AnalyzerIssue[] {
    return [...this.issues.entries()]
      .sort(([left], [right]) => compareExact(left, right))
      .map(([code, issue]) => ({
        code,
        count: issue.count,
        examples: issue.examples.slice(),
        truncated: issue.truncated,
      }));
  }
}

function compareIssueExamples(left: IssueExample, right: IssueExample): number {
  return compareExact(left.path ?? '', right.path ?? '')
    || compareExact(left.field ?? '', right.field ?? '')
    || compareExact(stableIssueValue(left.value), stableIssueValue(right.value))
    || compareExact(left.message, right.message);
}

function stableIssueValue(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value);
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
