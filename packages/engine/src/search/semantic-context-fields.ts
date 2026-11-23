import { createFieldMap } from '../fields/field-map.js';
import { Buffer } from 'node:buffer';

export type SemanticFieldCandidate = {
  readonly name: string | null;
  readonly nameBytes: number;
  readonly value: unknown;
};

export type SemanticFieldEntry = {
  readonly name: string;
  readonly value: unknown;
};

export function createSemanticFieldDictionary(): Record<string, unknown> {
  return createFieldMap<unknown>();
}

function syntheticFieldName(bytes: number, ordinal: number, collision: number): string {
  const base = `[field name omitted: ${bytes} bytes, ordinal ${ordinal}]`;
  return collision === 0 ? base : `${base} [collision ${collision}]`;
}

export function allocateSemanticFieldNames(
  candidates: readonly SemanticFieldCandidate[],
  maxNameBytes: number,
): readonly SemanticFieldEntry[] {
  const used = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.name !== null && candidate.nameBytes <= maxNameBytes) used.add(candidate.name);
  }

  return candidates.map((candidate, index) => {
    if (candidate.name !== null && candidate.nameBytes <= maxNameBytes) {
      return { name: candidate.name, value: candidate.value };
    }
    for (let collision = 0; collision <= candidates.length; collision += 1) {
      const name = syntheticFieldName(candidate.nameBytes, index + 1, collision);
      if (used.has(name)) continue;
      used.add(name);
      return { name, value: candidate.value };
    }
    throw new RangeError('Unable to allocate a bounded semantic field name');
  });
}

export function selectSemanticFields(
  fields: Readonly<Record<string, unknown>>,
  maxFields: number,
): readonly SemanticFieldCandidate[] {
  const selected: SemanticFieldCandidate[] = [];
  let examined = 0;
  for (const name in fields) {
    examined += 1;
    if (Object.hasOwn(fields, name)) {
      selected.push({ name, nameBytes: Buffer.byteLength(name, 'utf8'), value: Reflect.get(fields, name) });
    }
    if (selected.length >= maxFields || examined >= maxFields) break;
  }
  return selected.sort((left, right) => {
    const leftName = left.name ?? '';
    const rightName = right.name ?? '';
    return leftName.localeCompare(rightName);
  });
}
