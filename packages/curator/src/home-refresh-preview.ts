import { resolveConfiguredWikiStage, resolveWikiMaxTokens, resolveWikiModel, bindWikiStageClient } from './wiki-output-policy.js';
import type { CoreDeps } from './core.js';
import type { HomeRefreshPreview } from './home-refresh-types.js';
import type { Json, RefreshTargetData } from './provenance-types.js';
import { jsonDigest } from './provenance-evidence.js';
import { correctionInputs } from './db/provenance.js';
import { buildHomeRequest } from './home-request.js';
import { CURATOR_PAGE_SYSTEM_PROMPT } from './prompts/page.js';
import { SPEC_A_SYSTEM_PROMPT } from './synthesize.js';

export const homeRefreshSystem = (deps: CoreDeps): string =>
  deps.config.curatorProjectHomePrompt?.trim() ? deps.config.curatorProjectHomePrompt : SPEC_A_SYSTEM_PROMPT;
export const pageRefreshSystem = (deps: CoreDeps): string =>
  deps.config.curatorPagePrompt?.trim() ? deps.config.curatorPagePrompt : CURATOR_PAGE_SYSTEM_PROMPT;
export const digest = (value: unknown): string => jsonDigest(JSON.parse(JSON.stringify(value)) as Json);

/** Read-only: no queue, ledger admission, capture reservation, or provider call. */
export async function previewHomeRefresh(original: CoreDeps, outputRevisionId: string): Promise<HomeRefreshPreview> {
  const result: HomeRefreshPreview = { eligible: false, reasons: [], guard: null,
    target_kind: 'home', page_title: null, page_path: null, project_title: null, home_title: null, home_path: null, model: null,
    sections: ['At a glance', 'Now', 'Focus', 'Open threads', 'Sources', 'Log'] };
  const block = (code: string, message: string) => { result.reasons.push({ code, message }); };
  try {
    const deps = original.refreshDeps ? await original.refreshDeps() : original;
    const { config, engine, llm, db } = deps;
    if (!db) { block('STORAGE_UNAVAILABLE', 'Refresh history is unavailable.'); return result; }
    const status = await engine.inspectProvenance({ select: 'status' });
    if (status.select !== 'status' || status.capability_version !== 1
      || !status.inspection_features?.includes('selective_home_refresh_v1')) {
      block('UPGRADE_REQUIRED', 'Update Engine to enable rebuilding a single page.'); return result;
    }
    const target = await engine.inspectProvenance({ select: 'refresh_target', output_revision_id: outputRevisionId });
    if (target.select !== 'refresh_target') throw new Error('TARGET_UNAVAILABLE');
    const page = target.target_kind === 'page';
    result.project_title = target.project_title; result.home_title = target.home_title; result.home_path = target.home_path;
    if (page) {
      result.target_kind = 'page'; result.page_title = target.page_title ?? null; result.page_path = target.page_path ?? null;
      result.sections = ['Summary', 'Log'];
    }
    for (const code of target.reasons) block(code, ({
      HISTORICAL_OUTPUT: 'Select the latest captured version of this page.',
      MANAGED_CONTENT_CHANGED: 'Generated text has changed since this capture. Rebuild the entire wiki first.',
      PAGE_NOT_ACTIVE: 'This page is dormant or retired. Rebuild the entire wiki instead.',
      HOME_OWNERSHIP_CHANGED: 'This is no longer the single project home.',
      HOME_MISSING: 'The project home is missing.',
      INVALID_CATALOG: 'The page catalog needs repair before refreshing.',
      OUTPUT_UNAVAILABLE: 'The retained capture is unavailable.',
    } as Record<string, string>)[code] ?? 'This page cannot be safely rebuilt.');
    if (page && !status.inspection_features.includes('selective_page_refresh_v1'))
      block('UPGRADE_REQUIRED', 'Update Engine to enable rebuilding a sub-page.');
    if (!config.projectHomeProvenanceEnabled || !llm.supportsPreparedCapture || !llm.previewStructuredCall)
      block('CAPTURE_UNAVAILABLE', 'Captured wiki generation must be enabled.');
    if (page) {
      await previewPage(deps, target, status.limits, outputRevisionId, result, block);
      return result;
    }
    const homeModel = resolveWikiModel(config, 'home');
    const provider = config.modelProviders?.[homeModel];
    if (!provider || !homeModel || !Number.isInteger(config.homeMaxTokens) || config.homeMaxTokens <= 0)
      block('MODEL_UNAVAILABLE', 'Configure an available home model and output limit.');
    if (result.reasons.length || !target.eligible || !target.project_id || !target.home_node_id
      || !target.project_title || target.home_version === null || !target.topology_hash) return result;
    const homePolicy = resolveConfiguredWikiStage(config, llm, 'home', homeModel);
    const homeLlm = bindWikiStageClient(llm, homePolicy);
    const prepared = await homeLlm.previewStructuredCall!({ ...buildHomeRequest({ model: homeModel,
      maxTokens: homePolicy.maxTokens, system: homeRefreshSystem(deps), evidence: '', pageIndex: [],
      generatedAt: new Date('2000-01-01T00:00:00Z'), timeZone: config.curatorTz }), malformedOutputPolicy: 'fail-closed-redacted' });
    if (prepared.provider !== provider || prepared.model !== homeModel) throw new Error('MODEL_UNAVAILABLE');
    result.model = { ref: homeModel, provider, max_output_tokens: homePolicy.maxTokens };
    result.guard = { version: 1, vault_namespace: target.vault_namespace, project_id: target.project_id,
      home_node_id: target.home_node_id, output_revision_id: outputRevisionId, home_version: target.home_version,
      topology_hash: target.topology_hash,
      configuration_digest: digest({ prepared, model: homeModel, provider, maxTokens: homePolicy.maxTokens,
        configuration: homePolicy.configuration, system: homeRefreshSystem(deps),
        capture_limits: status.limits, meetingReads: config.meetingReads,
        noteReads: config.noteReads, bodyCharCap: config.bodyCharCap, semanticGapFill: config.semanticGapFill,
        semanticGapFillLimit: config.semanticGapFillLimit, semanticGapFillBodyReads: config.semanticGapFillBodyReads }),
      corrections_digest: digest(correctionInputs(db, target.project_title).map(({ note, observation }) =>
        ({ note, source: observation.source, content_hash: observation.content_hash }))) };
    result.eligible = true;
  } catch {
    block('READINESS_UNAVAILABLE', 'Could not verify current settings, capture, or model readiness. Try preview again.');
  }
  return result;
}

/** The page path's half of the preview. A page uses its own stage's model, and its system prompt
 *  is the one a full curation uses. */
async function previewPage(deps: CoreDeps, target: RefreshTargetData, limits: unknown, outputRevisionId: string,
  result: HomeRefreshPreview, block: (code: string, message: string) => void): Promise<void> {
  const { config, llm, db } = deps;
  const model = resolveWikiModel(config, 'page');
  const maxTokens = resolveWikiMaxTokens(config, 'page');
  const provider = config.modelProviders?.[model];
  if (!provider || !model || !Number.isInteger(maxTokens) || maxTokens <= 0)
    block('MODEL_UNAVAILABLE', 'Configure an available page model and output limit.');
  if (result.reasons.length || !target.eligible || !target.project_id || !target.home_node_id || !target.project_title
    || target.home_version === null || !target.topology_hash || !target.page_node_id
    || target.page_version === null || target.page_version === undefined) return;
  const policy = resolveConfiguredWikiStage(config, llm, 'page', model);
  result.model = { ref: model, provider: provider!, max_output_tokens: policy.maxTokens };
  result.guard = { version: 1, vault_namespace: target.vault_namespace, project_id: target.project_id,
    home_node_id: target.home_node_id, output_revision_id: outputRevisionId, home_version: target.home_version,
    topology_hash: target.topology_hash, page_node_id: target.page_node_id, page_version: target.page_version,
    configuration_digest: digest({ model, provider, maxTokens: policy.maxTokens, configuration: policy.configuration,
      system: pageRefreshSystem(deps), capture_limits: limits, bodyCharCap: config.bodyCharCap,
      semanticGapFillLimit: config.semanticGapFillLimit }),
    corrections_digest: digest(correctionInputs(db!, target.project_title).map(({ note, observation }) =>
      ({ note, source: observation.source, content_hash: observation.content_hash }))) };
  result.eligible = true;
}
