import type { LlmClient, StructuredCallRequest } from './llm/types.js';
import { providerRequestBytes } from './llm/request-budget.js';
import { renderTopicEvidence, selectTopicEvidence, type TopicEvidenceSource, type TopicEvidenceSelection } from './topic-evidence-selection.js';

export interface TopicRequestBudgetContext {
  readonly sources: readonly TopicEvidenceSource[];
  readonly mandatoryEvidence?: string;
  readonly recordSelection?: (stage: 'planner' | 'adjudicator' | 'page' | 'home', target: string | undefined,
    selection: TopicEvidenceSelection, requestBytes: number, maxBytes: number, fallback: boolean) => void;
  readonly query: string;
  readonly topicRequestMaxBytes: number;
  readonly topicPageRequestMaxBytes: number;
  readonly topicSourceExcerptMaxBytes: number;
}
export interface TopicRequestBudget {
  readonly context: TopicRequestBudgetContext;
  readonly stage?: 'planner' | 'adjudicator' | 'page' | 'home';
  readonly target?: string;
  readonly selectionFallback?: boolean;
  readonly selectedIds?: readonly string[];
  readonly query: string;
  readonly maxBytes: number;
  readonly onSelection?: (selection: TopicEvidenceSelection, requestBytes: number) => void;
}
export async function fitTopicRequest(input: {
  llm: LlmClient; model: string; context: TopicRequestBudgetContext; selectedIds?: readonly string[];
  query: string; maxBytes: number; buildRequest: (evidence: string) => StructuredCallRequest;
}): Promise<{ llm: LlmClient; request: StructuredCallRequest; selection: TopicEvidenceSelection; requestBytes: number }> {
  if (!input.llm.configurationFor || !input.llm.withConfiguration || !input.llm.previewStructuredCall)
    throw new Error('Topic request budgeting requires provider preview and configuration support');
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error('Invalid topic request budget');
  const llm = input.llm.withConfiguration(input.llm.configurationFor(input.model));
  if (!llm.previewStructuredCall) throw new Error('Topic request preview unavailable');
  let textBytes = input.maxBytes;
  for (;;) {
    const selection = selectTopicEvidence({ sources: input.context.sources, query: input.query,
      selectedIds: input.selectedIds, totalTextBytes: textBytes, perSourceBytes: input.context.topicSourceExcerptMaxBytes });
    const request = { ...input.buildRequest(renderTopicEvidence(selection, input.context.sources)),
      providerRequestMaxBytes: input.maxBytes };
    const requestBytes = providerRequestBytes((await llm.previewStructuredCall(request)).payload);
    if (requestBytes <= input.maxBytes) return { llm, request, selection, requestBytes };
    if (textBytes === 0) throw new Error('Topic request mandatory context exceeds byte budget');
    // Escaping and markers make bytes nonlinear: strictly shrink and remeasure the actual payload.
    textBytes = Math.max(0, textBytes - Math.max(requestBytes - input.maxBytes, Math.ceil(textBytes / 8)));
  }
}

export async function callWithTopicBudget(llm: LlmClient, budget: TopicRequestBudget | undefined,
  buildRequest: (evidence?: string) => StructuredCallRequest) {
  if (!budget) return llm.structuredCall(buildRequest());
  const fitted = await fitTopicRequest({ llm, model: buildRequest('').model, ...budget,
    buildRequest: evidence => buildRequest(evidence) });
  budget.context.recordSelection?.(budget.stage ?? 'planner', budget.target, fitted.selection,
    fitted.requestBytes, budget.maxBytes, budget.selectionFallback ?? false);
  budget.onSelection?.(fitted.selection, fitted.requestBytes);
  return fitted.llm.structuredCall(fitted.request);
}
