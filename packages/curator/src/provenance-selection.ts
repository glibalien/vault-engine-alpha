import { assertSourceObservation, EvidenceBudgetError, measureBundle, type BudgetDimension, type CaptureLimits } from './provenance-budget.js';
import { capturedBundle, HOME_BUDGET_ASSEMBLY, type EvidenceCollector } from './provenance-evidence.js';
import type { PreparedCapture } from './llm/types.js';
import type { BundleV1 } from './provenance-types.js';
import type { GapFillCandidate } from './types.js';
import { closedCaptureReason } from './provenance-home.js';

export type RenderedEvidence = { text: string; collector: EvidenceCollector };
export type SelectionInput = {
  candidates: readonly GapFillCandidate[];
  limits: CaptureLimits;
  render: (candidates: readonly GapFillCandidate[], budgetOmissions: BundleV1['omissions']) => RenderedEvidence;
  preview: (text: string) => Promise<PreparedCapture>;
};
export type SelectedEvidence = RenderedEvidence & {
  selectedCandidates: readonly GapFillCandidate[];
  budgetOmissions: BundleV1['omissions'];
};
const CODES: Record<Exclude<BudgetDimension, 'omissions'>, string> = {
  component: 'gap_fill_component_budget', items: 'gap_fill_item_budget',
  request: 'gap_fill_request_budget', bundle: 'gap_fill_bundle_budget',
};

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

/** Select from an already-read window; no reads or paid calls occur here. */
export async function selectHomeEvidence(input: SelectionInput): Promise<SelectedEvidence> {
  for (const candidate of input.candidates) assertSourceObservation(candidate.provenance_observation);
  const selected: GapFillCandidate[] = [];
  const omissions: BundleV1['omissions'] = [];
  const measure = async (rendered: RenderedEvidence) => {
    let preview: PreparedCapture;
    try { preview = await input.preview(rendered.text); }
    catch (error) { throw new Error(closedCaptureReason(error)); }
    return measureBundle(capturedBundle(preview, rendered.collector, HOME_BUDGET_ASSEMBLY), input.limits);
  };
  let rendered = input.render(selected, omissions);
  const protectedIssue = await measure(rendered);
  if (protectedIssue) throw new EvidenceBudgetError('selection', protectedIssue);
  for (const candidate of input.candidates) {
    const trial = input.render([...selected, candidate], omissions);
    const issue = await measure(trial);
    if (!issue) {
      selected.push(candidate);
      rendered = trial;
    } else {
      if (issue.dimension === 'omissions') throw new EvidenceBudgetError('selection', issue);
      omissions.push({ code: CODES[issue.dimension], source: candidate.provenance_observation!.source });
      rendered = input.render(selected, omissions);
      const omissionIssue = await measure(rendered);
      if (omissionIssue) throw new EvidenceBudgetError('selection', omissionIssue);
    }
  }
  const result = { ...rendered, selectedCandidates: selected, budgetOmissions: omissions };
  freeze(result);
  return result;
}
