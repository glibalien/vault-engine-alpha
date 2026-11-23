import { parseTopicSelection } from './topic-selection-state.js';
import type { TopicRefreshSourceRow } from './db/topic-refresh.js';
import { isCuratorJournalTitle } from './topic-source-policy.js';
import {
  sanitizeTopicWebMaterialityAssessment,
  type TopicWebMaterialityAssessment,
} from './topic-refresh-assessment.js';
import {
  topicVaultSourceFingerprint,
  type CanonicalWebProbe,
  type CanonicalWebProbeBuildResult,
} from './topic-refresh-evidence.js';

const MAX_CHANGED_SOURCE_NODE_IDS = 70;

export type TopicRefreshTrigger =
  | 'manual_request'
  | 'manual_force'
  | 'cadence_due'
  | 'baseline_retry'
  | 'vault_source_changed'
  | 'web_material_change'
  | 'not_due';

export type TopicRefreshAdmissionWarning =
  | 'source_baseline_not_ready'
  | 'source_read_unavailable'
  | 'web_baseline_not_ready'
  | 'web_probe_unavailable'
  | 'web_probe_overflow'
  | 'assessment_cap_exhausted'
  | 'assessment_failed'
  | 'refresh_state_persist_failed';

export interface TopicRefreshAdmission {
  admit: boolean;
  trigger: TopicRefreshTrigger;
  changedSourceNodeIds: string[];
  webProbe?: CanonicalWebProbe;
  webAssessment?: TopicWebMaterialityAssessment;
  warnings: TopicRefreshAdmissionWarning[];
}

export interface TopicRefreshAssessmentBudget {
  tryConsumeNovelCall(): boolean;
  remaining(): number;
}

export interface TopicRefreshAdmissionInput {
  scheduled: boolean;
  force: boolean;
  cadenceDue: boolean;
  earlyRefreshEnabled: boolean;
  persistProbeCache: boolean;
}

export type TopicSourceReadResult =
  | {
      nodeId: string;
      state: 'present';
      title: string;
      types: string[];
      renderedBody: string;
      /** The body as wikis compare it (#332; `comparableTopicBody`): links read as words, then cut. */
      comparableBody?: string;
    }
  | {
      nodeId: string;
      state: 'missing';
    }
  | {
      nodeId: string;
      state: 'unavailable';
    };

export interface TopicSourceComparison {
  results: readonly TopicSourceReadResult[];
}

export interface TopicRefreshStateSnapshot {
  pendingSourceChange: boolean;
  pendingBaselineRetry: boolean;
  sourceCommittedAt?: string;
  committedSources: readonly TopicRefreshSourceRow[];
  committedWebProbe?: CanonicalWebProbe;
  lastProbe?: {
    probe: CanonicalWebProbe;
    assessment: TopicWebMaterialityAssessment;
  };
}

export interface TopicRefreshAdmissionDeps {
  loadState(): TopicRefreshStateSnapshot;
  readCommittedSources(
    sources: readonly TopicRefreshSourceRow[],
  ): Promise<TopicSourceComparison>;
  probeWeb(): Promise<CanonicalWebProbeBuildResult>;
  assessWeb(
    committed: CanonicalWebProbe,
    current: CanonicalWebProbe,
  ): Promise<TopicWebMaterialityAssessment>;
  persistProbeCache?(
    probe: CanonicalWebProbe,
    assessment: TopicWebMaterialityAssessment,
  ): void;
  budget: TopicRefreshAssessmentBudget;
}

function result(
  admit: boolean,
  trigger: TopicRefreshTrigger,
  warnings: TopicRefreshAdmissionWarning[],
  options: {
    changedSourceNodeIds?: string[];
    webProbe?: CanonicalWebProbe;
    webAssessment?: TopicWebMaterialityAssessment;
  } = {},
): TopicRefreshAdmission {
  return {
    admit,
    trigger,
    changedSourceNodeIds: options.changedSourceNodeIds ?? [],
    ...(options.webProbe === undefined ? {} : { webProbe: options.webProbe }),
    ...(options.webAssessment === undefined ? {} : { webAssessment: options.webAssessment }),
    warnings,
  };
}

function addWarning(
  warnings: TopicRefreshAdmissionWarning[],
  warning: TopicRefreshAdmissionWarning,
): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function sourceBaselineReady(snapshot: TopicRefreshStateSnapshot, sources: readonly TopicRefreshSourceRow[]): boolean {
  if (snapshot.sourceCommittedAt === undefined) return false;
  return sources.every(row =>
    row.evidence_state !== null
    && row.body_included !== null
    && row.fingerprint_version !== null
    && row.evidence_hash !== null);
}

function changedSourceNodeIds(
  rows: readonly TopicRefreshSourceRow[],
  comparison: TopicSourceComparison,
  warnings: TopicRefreshAdmissionWarning[],
): string[] {
  const readsByNodeId = new Map(comparison.results.map(read => [read.nodeId, read]));
  const changed = new Set<string>();

  for (const row of rows) {
    const read = readsByNodeId.get(row.node_id);
    if (row.source_kind === 'observed' && read?.state === 'present' && isCuratorJournalTitle(read.title)) continue;
    if (read === undefined || read.state === 'unavailable') {
      addWarning(warnings, 'source_read_unavailable');
      continue;
    }

    try {
      const present = (keepLinks: boolean) => read.state === 'missing'
        ? topicVaultSourceFingerprint({ nodeId: row.node_id, state: 'missing' })
        : topicVaultSourceFingerprint({
            nodeId: row.node_id,
            title: read.title,
            types: read.types,
            bodyIncluded: row.body_included === 1,
            renderedBody: read.renderedBody,
            ...(keepLinks || read.comparableBody === undefined || row.body_included !== 1 ? {} : { comparableBody: read.comparableBody }),
            keepLinks,
          });
      // A source matches its record read either way: with links as their words (records since
      // #332), or as written (records from before, or a body that holds no link). So a link added
      // around words already in a source is no change, and no real change matches either.
      const fingerprints = [present(false), present(true)];
      const selection = row.selection_json == null ? undefined : parseTopicSelection(row.selection_json);
      if (selection && (selection.freshnessHash !== row.freshness_hash || selection.freshnessVersion !== row.freshness_version))
        throw new Error('Inconsistent topic freshness metadata');
      if ((row.freshness_hash != null || row.freshness_version != null) && !selection)
        throw new Error('Missing topic selection metadata');
      const recordedVersion = selection ? row.freshness_version : row.fingerprint_version;
      const recordedHash = selection ? row.freshness_hash : row.evidence_hash;
      if (!fingerprints.some(fingerprint => recordedVersion === fingerprint.version && recordedHash === fingerprint.hash)) {
        changed.add(row.node_id);
      }
    } catch {
      addWarning(warnings, 'source_read_unavailable');
    }
  }

  return [...changed].sort().slice(0, MAX_CHANGED_SOURCE_NODE_IDS);
}

function allowedAssessmentUrls(
  committed: CanonicalWebProbe,
  current: CanonicalWebProbe,
): ReadonlySet<string> {
  return new Set([...committed.results, ...current.results].map(item => item.url));
}

function assessmentResult(
  warnings: TopicRefreshAdmissionWarning[],
  current: CanonicalWebProbe,
  assessment: TopicWebMaterialityAssessment,
): TopicRefreshAdmission {
  const material = assessment.verdict === 'material';
  return result(material, material ? 'web_material_change' : 'not_due', warnings, {
    webProbe: current,
    webAssessment: assessment,
  });
}

export async function admitTopicRefresh(
  input: TopicRefreshAdmissionInput,
  deps: TopicRefreshAdmissionDeps,
): Promise<TopicRefreshAdmission> {
  if (!input.scheduled) {
    return result(true, input.force ? 'manual_force' : 'manual_request', []);
  }
  if (input.force) return result(true, 'manual_force', []);
  if (input.cadenceDue) return result(true, 'cadence_due', []);

  const warnings: TopicRefreshAdmissionWarning[] = [];
  const snapshot = deps.loadState();
  if (snapshot.pendingBaselineRetry) return result(true, 'baseline_retry', warnings);
  if (!input.earlyRefreshEnabled) return result(false, 'not_due', warnings);
  if (snapshot.pendingSourceChange) return result(true, 'vault_source_changed', warnings);

  // Ignore legacy implicit journal subscriptions immediately. The next successful
  // live synthesis replaces observed membership through the normal commit seam.
  const sources = snapshot.committedSources.filter(row =>
    row.source_kind === 'explicit' || !isCuratorJournalTitle(row.title_at_commit));
  if (!sourceBaselineReady(snapshot, sources)) {
    addWarning(warnings, 'source_baseline_not_ready');
  } else if (sources.length > 0) {
    let changed: string[] = [];
    try {
      const comparison = await deps.readCommittedSources(sources);
      changed = changedSourceNodeIds(sources, comparison, warnings);
    } catch {
      addWarning(warnings, 'source_read_unavailable');
    }
    if (changed.length > 0) {
      return result(true, 'vault_source_changed', warnings, { changedSourceNodeIds: changed });
    }
  }

  const committed = snapshot.committedWebProbe;
  if (committed === undefined) {
    addWarning(warnings, 'web_baseline_not_ready');
    return result(false, 'not_due', warnings);
  }

  let current: CanonicalWebProbe;
  try {
    const probe = await deps.probeWeb();
    if (!probe.ok) {
      addWarning(warnings, 'web_probe_overflow');
      return result(false, 'not_due', warnings);
    }
    current = probe.probe;
  } catch {
    addWarning(warnings, 'web_probe_unavailable');
    return result(false, 'not_due', warnings);
  }

  if (current.hash === committed.hash) {
    return result(false, 'not_due', warnings, { webProbe: current });
  }

  if (snapshot.lastProbe?.probe.hash === current.hash) {
    const cached = sanitizeTopicWebMaterialityAssessment(
      snapshot.lastProbe.assessment,
      allowedAssessmentUrls(committed, current),
    );
    return assessmentResult(warnings, current, cached);
  }

  if (!deps.budget.tryConsumeNovelCall()) {
    addWarning(warnings, 'assessment_cap_exhausted');
    return result(false, 'not_due', warnings, { webProbe: current });
  }

  let assessment: TopicWebMaterialityAssessment;
  try {
    const raw = await deps.assessWeb(committed, current);
    assessment = sanitizeTopicWebMaterialityAssessment(
      raw,
      allowedAssessmentUrls(committed, current),
    );
  } catch {
    addWarning(warnings, 'assessment_failed');
    return result(false, 'not_due', warnings, { webProbe: current });
  }

  if (input.persistProbeCache && deps.persistProbeCache !== undefined) {
    try {
      deps.persistProbeCache(current, assessment);
    } catch {
      addWarning(warnings, 'refresh_state_persist_failed');
    }
  }

  return assessmentResult(warnings, current, assessment);
}
