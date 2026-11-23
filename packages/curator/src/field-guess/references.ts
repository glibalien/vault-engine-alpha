import type { EngineNode, EngineNodeSummary } from '../types.js';
import type {
  FieldGuessFieldCandidate,
  SanitizedFieldGuessDecision,
} from './types.js';

export interface FieldGuessReferenceEngine {
  findNodesByExactTitle(title: string, limit: number): Promise<EngineNodeSummary[]>;
  getNode(nodeId: string, options: { includeEmbeds: false }): Promise<EngineNode>;
}

const CANONICAL_TITLE_ROUND_TRIP_ERROR =
  'Canonical reference title cannot round-trip through Engine wiki-link storage.';

function coerceEngineReferenceText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return trimmed;
  const inner = trimmed.slice(2, -2);
  return inner.includes('|') ? (inner.split('|')[0] ?? '') : inner;
}

/** Mirrors Engine's scalar-reference persistence seam through direct frontmatter
 * indexing. Both the persisted field text and extracted relationship target
 * must retain the exact canonical title. */
function canonicalTitleRoundTrips(title: string): boolean {
  const stored = coerceEngineReferenceText(title);
  const rendered = `[[${stored}]]`;
  const targets: string[] = [];
  const parsed = rendered.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string) => {
      targets.push(target);
      return target;
    },
  );
  return stored === title
    && parsed === title
    && targets.length === 1
    && targets[0] === title;
}

function rejection(
  decision: SanitizedFieldGuessDecision,
  error: string,
): SanitizedFieldGuessDecision {
  return {
    field: decision.field,
    kind: 'rejected_reference',
    reason: decision.reason,
    error,
  };
}

function operationalFailure(
  decision: SanitizedFieldGuessDecision,
  error: string,
): SanitizedFieldGuessDecision {
  return {
    field: decision.field,
    kind: 'reference_error',
    reason: decision.reason,
    error,
  };
}

type ReferenceResolution =
  | { kind: 'resolved'; title: string; nodeId: string; requiredType: string | null }
  | { kind: 'rejected'; error: string }
  | { kind: 'operational_error'; error: string };

async function resolveOne(
  title: unknown,
  field: FieldGuessFieldCandidate,
  engine: FieldGuessReferenceEngine,
): Promise<ReferenceResolution> {
  if (typeof title !== 'string' || title.trim() === '') {
    return { kind: 'rejected', error: 'Reference title must be non-empty text.' };
  }

  let matches: EngineNodeSummary[];
  try {
    matches = await engine.findNodesByExactTitle(title, 2);
  } catch {
    return { kind: 'operational_error', error: 'Exact-title reference lookup failed.' };
  }
  const unique = new Map<string, EngineNodeSummary>();
  for (const match of matches) {
    if (match === null || typeof match !== 'object' || typeof match.id !== 'string' || match.id.trim() === '') {
      return { kind: 'operational_error', error: 'Exact-title reference lookup returned invalid data.' };
    }
    unique.set(match.id, match);
  }
  if (unique.size === 0) return { kind: 'rejected', error: 'No exact-title reference match exists.' };
  if (unique.size !== 1) return { kind: 'rejected', error: 'Exact-title reference match is ambiguous.' };

  const nodeId = unique.keys().next().value as string;
  try {
    const canonical = await engine.getNode(nodeId, { includeEmbeds: false });
    if (typeof canonical.title !== 'string' || canonical.title.trim() === '') {
      return { kind: 'operational_error', error: 'Canonical reference fetch returned invalid data.' };
    }
    if (!Array.isArray(canonical.types) || !canonical.types.every(type => typeof type === 'string')) {
      return { kind: 'operational_error', error: 'Canonical reference fetch returned invalid data.' };
    }
    if (!canonicalTitleRoundTrips(canonical.title)) {
      return { kind: 'rejected', error: CANONICAL_TITLE_ROUND_TRIP_ERROR };
    }
    if (field.reference_target !== null && !canonical.types.includes(field.reference_target)) {
      return { kind: 'rejected', error: 'Reference target has the wrong type.' };
    }
    return {
      kind: 'resolved',
      title: canonical.title,
      nodeId,
      requiredType: field.reference_target,
    };
  } catch {
    return { kind: 'operational_error', error: 'Canonical reference fetch failed.' };
  }
}

function resolvedDecision(
  decision: SanitizedFieldGuessDecision,
  resolved: ReferenceResolution,
): SanitizedFieldGuessDecision {
  if (resolved.kind === 'resolved') {
    return {
      ...decision,
      value: resolved.title,
      reference_targets: [{
        node_id: resolved.nodeId,
        title: resolved.title,
        required_type: resolved.requiredType,
      }],
    };
  }
  if (resolved.kind === 'operational_error') return operationalFailure(decision, resolved.error);
  return rejection(decision, resolved.error);
}

export async function resolveFieldGuessReferences(
  decision: SanitizedFieldGuessDecision,
  field: FieldGuessFieldCandidate,
  engine: FieldGuessReferenceEngine,
): Promise<SanitizedFieldGuessDecision> {
  if (decision.kind !== 'accepted') return decision;
  const scalarReference = field.field_type === 'reference';
  const listReference = field.field_type === 'list' && field.list_item_type === 'reference';
  if (!scalarReference && !listReference) return decision;

  if (scalarReference) {
    const resolved = await resolveOne(decision.value, field, engine);
    return resolvedDecision(decision, resolved);
  }

  if (!Array.isArray(decision.value) || decision.value.length === 0) {
    return rejection(decision, 'Reference list must be non-empty.');
  }
  const canonicalTitles: string[] = [];
  const referenceTargets: NonNullable<SanitizedFieldGuessDecision['reference_targets']> = [];
  for (const title of decision.value) {
    const resolved = await resolveOne(title, field, engine);
    if (resolved.kind !== 'resolved') return resolvedDecision(decision, resolved);
    canonicalTitles.push(resolved.title);
    referenceTargets.push({
      node_id: resolved.nodeId,
      title: resolved.title,
      required_type: resolved.requiredType,
    });
  }
  return { ...decision, value: canonicalTitles, reference_targets: referenceTargets };
}
