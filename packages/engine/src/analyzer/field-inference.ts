import { cleanFieldValue } from '../parser/frontmatter.js';
import type { YamlValue } from '../parser/types.js';
import { isStrictIsoDateString } from '../validation/date.js';
import { coerceValue, normalizeEnumValue, type CoercionResult } from '../validation/coerce.js';
import { resolveDefaultValue } from '../validation/resolve-default.js';
import { BoundedFirstSamples } from './bounded-samples.js';
import type {
  AmbiguousGlobalField,
  AnalyzerFieldType,
  FieldEvidence,
  FieldTypeChoice,
  FieldTypeOption,
  ProposedGlobalField,
} from './report.js';

const MAX_SAMPLE_VALUES = 10;
const WHOLE_WIKI_LINK_RE = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/;

type ScalarShape = 'string' | 'number' | 'date' | 'boolean' | 'reference';
type ObservationShape =
  | { kind: 'null' }
  | { kind: 'scalar'; scalar: ScalarShape; value: unknown; referenceTarget?: string }
  | {
      kind: 'list';
      item: ScalarShape | 'unknown';
      values: unknown[];
      referenceTargets?: string[];
    }
  | { kind: 'unsupported'; reason: 'object' | 'nested-list' | 'mixed-list' };

export function shouldInferEnum(input: {
  stringObservationCount: number;
  totalObservationCount: number;
  distinctValueCount: number;
}): boolean {
  return input.stringObservationCount >= 5
    && input.distinctValueCount <= 10
    && input.totalObservationCount > 0
    && input.distinctValueCount / input.totalObservationCount <= 0.30;
}

/**
 * A chosen type replaces inference when every value converts to it; otherwise the field
 * still needs review.
 */
export function inferFieldDefinition(
  name: string,
  observations: readonly YamlValue[],
  chosen?: FieldTypeChoice,
): ProposedGlobalField | AmbiguousGlobalField {
  const shapes = observations.map(classifyObservation);
  const evidence = buildEvidence(observations, shapes);
  if (chosen) {
    const unconverted = countUnconverted(observations, chosen);
    if (unconverted === 0) {
      return applyReady(name, chosen.field_type, evidence, chosen.list_item_type ? { list_item_type: chosen.list_item_type } : {});
    }
    const reason = `${unconverted} ${unconverted === 1 ? 'value does' : 'values do'} not convert to the chosen ${describeChoice(chosen)}`;
    return needsReview(name, [...reviewReasons(shapes), reason], evidence, observations, shapes);
  }
  const reasons = reviewReasons(shapes);
  if (reasons.length > 0) return needsReview(name, reasons, evidence, observations, shapes);

  const nonNull = shapes.filter(
    (shape): shape is Exclude<ObservationShape, { kind: 'null' }> => shape.kind !== 'null',
  );
  const first = nonNull[0];
  if (first.kind === 'scalar') {
    if (first.scalar === 'string') {
      const strings = nonNull.map(shape => (shape as Extract<ObservationShape, { kind: 'scalar' }>).value as string);
      const counts = countStrings(strings);
      if (shouldInferEnum({
        stringObservationCount: strings.length,
        totalObservationCount: nonNull.length,
        distinctValueCount: counts.size,
      })) {
        return applyReady(name, 'enum', evidence, {
          enum_values: [...counts.entries()]
            .sort(([leftValue, leftCount], [rightValue, rightCount]) =>
              rightCount - leftCount || compareExact(leftValue, rightValue))
            .map(([value]) => value),
        });
      }
    }
    return applyReady(name, first.scalar, evidence);
  }

  const itemShape = nonNull.find(
    (shape): shape is Extract<ObservationShape, { kind: 'list' }> =>
      shape.kind === 'list' && shape.item !== 'unknown',
  );
  return applyReady(name, 'list', evidence, { list_item_type: itemShape?.item as ScalarShape });
}

function needsReview(
  name: string,
  reasons: string[],
  evidence: FieldEvidence,
  observations: readonly YamlValue[],
  shapes: ObservationShape[],
): AmbiguousGlobalField {
  return {
    name,
    status: 'needs_review',
    reasons: [...new Set(reasons)].sort(compareExact),
    evidence,
    options: fieldTypeOptions(observations, shapes),
  };
}

/** Text, then the most common value shape unless that is text too. */
function fieldTypeOptions(observations: readonly YamlValue[], shapes: ObservationShape[]): FieldTypeOption[] {
  const text: FieldTypeChoice = { field_type: 'string' };
  const options: FieldTypeOption[] = [{ option: 'text', ...text, unconverted: countUnconverted(observations, text) }];
  const dominant = dominantShape(shapes);
  if (dominant !== null && dominant.field_type !== 'string') {
    options.push({ option: 'dominant', ...dominant, unconverted: countUnconverted(observations, dominant) });
  }
  return options;
}

/** The most frequent scalar or typed-list shape; ties go to the first shape name. */
function dominantShape(shapes: ObservationShape[]): FieldTypeChoice | null {
  const counts = new Map<string, { choice: FieldTypeChoice; count: number }>();
  for (const shape of shapes) {
    let choice: FieldTypeChoice | null = null;
    if (shape.kind === 'scalar') choice = { field_type: shape.scalar };
    else if (shape.kind === 'list' && shape.item !== 'unknown') choice = { field_type: 'list', list_item_type: shape.item };
    if (choice === null) continue;
    const key = describeShape(shape);
    const entry = counts.get(key) ?? { choice, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const ranked = [...counts.entries()].sort(([leftKey, left], [rightKey, right]) =>
    right.count - left.count || compareExact(leftKey, rightKey));
  return ranked[0]?.[1].choice ?? null;
}

/**
 * A frontmatter value as Engine would store it in a field of this type: its parser strips
 * wiki-link brackets to the target, then validation resolves a `$mtime`/`$ctime`/`$now`
 * token and coerces. The token's date never decides whether it converts, so no file
 * context is needed.
 */
export function engineFieldValue(value: YamlValue, type: FieldTypeChoice): CoercionResult {
  const options = type.list_item_type ? { list_item_type: type.list_item_type } : undefined;
  return coerceValue(resolveDefaultValue(cleanFieldValue(value), null), type.field_type, options);
}

/** Values Engine would refuse for a type. */
function countUnconverted(observations: readonly YamlValue[], choice: FieldTypeChoice): number {
  return observations.filter(value => value !== null && !engineFieldValue(value, choice).ok).length;
}

function describeChoice(choice: FieldTypeChoice): string {
  return choice.field_type === 'list' ? `list of ${choice.list_item_type}` : choice.field_type;
}

function classifyObservation(value: YamlValue): ObservationShape {
  if (value === null) return { kind: 'null' };
  const scalar = classifyScalar(value);
  if (scalar !== null) return scalar;

  if (Array.isArray(value)) {
    const nestedWikiLink = nestedWikiLinkTarget(value);
    if (nestedWikiLink !== null) {
      return {
        kind: 'scalar',
        scalar: 'reference',
        value,
        referenceTarget: nestedWikiLink,
      };
    }
    if (value.length === 0) return { kind: 'list', item: 'unknown', values: [] };
    if (value.some(item => Array.isArray(item))) {
      return { kind: 'unsupported', reason: 'nested-list' };
    }
    const itemShapes = value.map(classifyScalar);
    if (itemShapes.some(item => item === null)) {
      return { kind: 'unsupported', reason: 'mixed-list' };
    }
    const scalars = itemShapes as Array<Extract<ObservationShape, { kind: 'scalar' }>>;
    const item = scalars[0].scalar;
    if (scalars.some(shape => shape.scalar !== item)) {
      return { kind: 'unsupported', reason: 'mixed-list' };
    }
    return {
      kind: 'list',
      item,
      values: scalars.map(shape => shape.value),
      referenceTargets: item === 'reference'
        ? scalars.map(shape => shape.referenceTarget as string)
        : undefined,
    };
  }

  return { kind: 'unsupported', reason: 'object' };
}

function classifyScalar(
  value: YamlValue,
): Extract<ObservationShape, { kind: 'scalar' }> | null {
  if (typeof value === 'number') return { kind: 'scalar', scalar: 'number', value };
  if (typeof value === 'boolean') return { kind: 'scalar', scalar: 'boolean', value };
  if (typeof value !== 'string') return null;
  const reference = WHOLE_WIKI_LINK_RE.exec(value);
  if (reference) {
    return {
      kind: 'scalar',
      scalar: 'reference',
      value,
      referenceTarget: reference[1],
    };
  }
  return {
    kind: 'scalar',
    scalar: isStrictIsoDateString(value) ? 'date' : 'string',
    value,
  };
}

function nestedWikiLinkTarget(value: YamlValue[]): string | null {
  if (
    value.length !== 1
    || !Array.isArray(value[0])
    || value[0].length !== 1
    || typeof value[0][0] !== 'string'
  ) {
    return null;
  }
  const target = value[0][0];
  const separator = target.indexOf('|');
  const canonical = separator === -1 ? target : target.slice(0, separator);
  return canonical.length > 0 ? canonical : null;
}

function reviewReasons(shapes: ObservationShape[]): string[] {
  const reasons = new Set<string>();
  for (const shape of shapes) {
    if (shape.kind === 'unsupported') reasons.add(reasonForUnsupported(shape.reason));
  }
  const supported = shapes.filter(
    (shape): shape is Extract<ObservationShape, { kind: 'scalar' | 'list' }> =>
      shape.kind === 'scalar' || shape.kind === 'list',
  );
  if (supported.length === 0) {
    reasons.add('insufficient non-null shape evidence');
    return [...reasons].sort(compareExact);
  }
  const families = new Set(supported.map(shape => shape.kind));
  if (families.size > 1) reasons.add('conflicting scalar and list observations');

  const scalars = supported.filter(
    (shape): shape is Extract<ObservationShape, { kind: 'scalar' }> => shape.kind === 'scalar',
  );
  if (new Set(scalars.map(shape => shape.scalar)).size > 1) {
    reasons.add('conflicting scalar shapes');
  }

  const lists = supported.filter(
    (shape): shape is Extract<ObservationShape, { kind: 'list' }> => shape.kind === 'list',
  );
  const knownListItems = new Set(lists.map(shape => shape.item).filter(item => item !== 'unknown'));
  if (knownListItems.size > 1) reasons.add('conflicting list item shapes');
  if (lists.length > 0 && knownListItems.size === 0) {
    reasons.add('empty lists have no item-type evidence');
  }
  return [...reasons].sort(compareExact);
}

function reasonForUnsupported(reason: Extract<ObservationShape, { kind: 'unsupported' }>['reason']): string {
  switch (reason) {
    case 'object': return 'object observation is unsupported';
    case 'nested-list': return 'nested list observation is unsupported';
    case 'mixed-list': return 'mixed list item shapes are unsupported';
  }
}

function buildEvidence(
  observations: readonly YamlValue[],
  shapes: ObservationShape[],
): FieldEvidence {
  const shapeDistribution = new Map<string, number>();
  const distinctValues = new Set<string>();
  const samples = new BoundedFirstSamples<unknown>(MAX_SAMPLE_VALUES);

  for (let index = 0; index < shapes.length; index++) {
    const shape = shapes[index];
    const shapeKey = describeShape(shape);
    shapeDistribution.set(shapeKey, (shapeDistribution.get(shapeKey) ?? 0) + 1);
    if (shape.kind === 'null') continue;

    const sampleKey = stableValueKey(observations[index]);
    samples.add(sampleKey, observations[index]);
    for (const distinctValue of valuesForDistinctCount(shape, observations[index])) {
      distinctValues.add(stableValueKey(distinctValue));
    }
  }

  return {
    observations: observations.length,
    null_or_missing: shapes.filter(shape => shape.kind === 'null').length,
    distinct_values: distinctValues.size,
    shape_distribution: Object.fromEntries(
      [...shapeDistribution.entries()].sort(([left], [right]) => compareExact(left, right)),
    ),
    sample_values: samples.values(),
    samples_truncated: samples.truncated,
  };
}

function describeShape(shape: ObservationShape): string {
  switch (shape.kind) {
    case 'null': return 'null';
    case 'scalar': return shape.scalar;
    case 'list': return `list:${shape.item}`;
    case 'unsupported': return shape.reason;
  }
}

function valuesForDistinctCount(shape: ObservationShape, raw: YamlValue): unknown[] {
  if (shape.kind === 'null') return [];
  if (shape.kind === 'scalar') return [shape.value];
  if (shape.kind === 'list') return shape.values;
  return [raw];
}

function stableValueKey(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
  }
  if (value instanceof Date) return `date-object:${value.toISOString()}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function countStrings(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = normalizeEnumValue(value);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function applyReady(
  name: string,
  fieldType: AnalyzerFieldType,
  evidence: FieldEvidence,
  extra: Pick<ProposedGlobalField, 'enum_values' | 'list_item_type'> = {},
): ProposedGlobalField {
  return {
    name,
    field_type: fieldType,
    ...extra,
    required: false,
    status: 'apply_ready',
    evidence,
  };
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
