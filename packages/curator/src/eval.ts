import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliModelRef, shortModelLabel } from './eval/model-ref.js';
import type { Engine } from './engine.js';
import type { LlmClient } from './llm/types.js';
import { providerForModel } from './llm/provider-for-model.js';
import type { Config } from './config.js';
import { loadCorpus, snapshotProject, writeFixture, readFixture } from './eval/corpus.js';
import { resolveProfiles } from './eval/profile.js';
import { runMatrix } from './eval/runner.js';
import type { EvalModel } from './eval/runner.js';
import { computeMetrics } from './eval/metrics.js';
import { judgePair, aggregateVerdicts, normalizedWinner } from './eval/judge.js';
import type { Scoreboard, JudgeVerdict } from './eval/judge.js';
import { renderReportHtml, renderReportMarkdown, reportJson } from './eval/render.js';
import type { ReportInput } from './eval/render.js';
import { computeRollups } from './eval/rollup.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface EvalDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
}

export interface RunOpts {
  fixturesDir: string;
  outDir: string;
  profileIds: string[];
  models?: EvalModel[];
  projects?: string[];
  live: boolean;
  judge: boolean;
  judgeModel: string;
}

export interface SnapshotOpts {
  corpusPath: string;
  fixturesDir: string;
  projects?: string[];
}

// ---------------------------------------------------------------------------
// runSnapshot
// ---------------------------------------------------------------------------

export async function runSnapshot(
  deps: EvalDeps,
  opts: SnapshotOpts,
): Promise<string[]> {
  const { engine, config } = deps;

  // Determine which projects to snapshot
  let titles: string[];
  if (opts.projects && opts.projects.length > 0) {
    titles = opts.projects;
  } else {
    // Try corpus file first
    let corpusTitles: string[] = [];
    try {
      const entries = loadCorpus(opts.corpusPath);
      corpusTitles = entries.map((e) => e.title);
    } catch {
      // corpus file may not exist
    }

    if (corpusTitles.length > 0) {
      titles = corpusTitles;
    } else {
      // Fall back to live active projects
      const projects = await engine.listActiveProjects(config.activeStatuses, config.projectType, config.projectStatusField);
      titles = projects.map((p) => p.title);
    }
  }

  const written: string[] = [];
  for (const title of titles) {
    console.log(`[snapshot] ${title} ...`);
    const fixture = await snapshotProject(engine, config, title);
    const path = writeFixture(opts.fixturesDir, fixture);
    console.log(`[snapshot] wrote ${path}`);
    written.push(path);
  }
  return written;
}

// ---------------------------------------------------------------------------
// runEval
// ---------------------------------------------------------------------------

/** Ensure the anchor model is present; prepend it (so it renders first) when missing. */
function withAnchor(models: EvalModel[], anchorModel: string): EvalModel[] {
  if (models.some((m) => m.model === anchorModel)) return models;
  return [{ model: anchorModel, label: shortModelLabel(anchorModel) }, ...models];
}

export async function runEval(
  deps: EvalDeps,
  opts: RunOpts,
): Promise<{ reportPath: string; totalCostUsd: number | null }> {
  const { engine, llm, config } = deps;

  // Load or snapshot fixtures
  let fixtures = [];
  if (opts.live) {
    // Snapshot fresh into memory — write to fixturesDir then read back
    let titles: string[];
    if (opts.projects && opts.projects.length > 0) {
      titles = opts.projects;
    } else {
      const projects = await engine.listActiveProjects(config.activeStatuses, config.projectType, config.projectStatusField);
      titles = projects.map((p) => p.title);
    }
    for (const title of titles) {
      const fixture = await snapshotProject(engine, config, title);
      writeFixture(opts.fixturesDir, fixture);
    }
  }

  // Read all *.json fixture files from fixturesDir
  let entries: string[];
  try {
    entries = readdirSync(opts.fixturesDir).filter((f) => f.endsWith('.json'));
  } catch {
    entries = [];
  }
  fixtures = entries.map((f) => readFixture(join(opts.fixturesDir, f)));

  // Resolve profiles
  const profiles = resolveProfiles(opts.profileIds, config);

  // The anchor model (config.model — what prod runs today) is always in the matrix:
  // judging and cost ratios are anchored to it.
  const models = withAnchor(opts.models ?? [], config.model);

  // Run the matrix
  const runs = await runMatrix(llm, fixtures, profiles, models);

  // Group runs by project
  const byProjectMap = new Map<
    string,
    Array<{ run: (typeof runs)[0]; metrics: ReturnType<typeof computeMetrics> }>
  >();

  for (const run of runs) {
    // Find the matching fixture for this run
    const fixture = fixtures.find((f) => f.project.title === run.project);
    if (!fixture) continue;

    const metrics = computeMetrics(run.sections, fixture.evidence);
    const existing = byProjectMap.get(run.project) ?? [];
    existing.push({ run, metrics });
    byProjectMap.set(run.project, existing);
  }

  // Judge if requested and ≥2 variants (profiles × models) exist for the project
  const reportByProject: ReportInput['byProject'] = [];
  const allJudgements: Array<{ aId: string; bId: string; verdict: JudgeVerdict; orderSplit?: boolean }> = [];

  for (const [project, variants] of byProjectMap) {
    let judgements: ReportInput['byProject'][0]['judgements'] = undefined;

    if (opts.judge && variants.length >= 2) {
      judgements = [];
      const anchorVariant = variants.find(
        (v) => v.run.profileId === 'baseline' && v.run.model === config.model,
      );
      if (anchorVariant) {
        for (const variant of variants) {
          if (variant === anchorVariant) continue;
          const aId = anchorVariant.run.variantId;
          const bId = variant.run.variantId;
          // Double-pass: judge once with the anchor in position A, once swapped.
          // A pass where the winner flips with position is an order-split — a coin
          // flip, not a win — so the flag rides on both entries of the pair.
          const v1 = await judgePair(llm, opts.judgeModel, project, anchorVariant.run, variant.run);
          const v2 = await judgePair(llm, opts.judgeModel, project, variant.run, anchorVariant.run);
          const orderSplit = normalizedWinner(aId, bId, v1) !== normalizedWinner(bId, aId, v2);
          const j1 = { aId, bId, verdict: v1, orderSplit };
          const j2 = { aId: bId, bId: aId, verdict: v2, orderSplit };
          judgements.push(j1, j2);
          allJudgements.push(j1, j2);
        }
      } else {
        console.warn(`[eval] --judge: no anchor variant (baseline × ${config.model}) for project "${project}" — judging skipped`);
      }
    }

    reportByProject.push({ project, variants, judgements });
  }

  // Compute total cost
  let allNull = true;
  let totalCost = 0;
  for (const run of runs) {
    if (run.costUsd !== null) {
      allNull = false;
      totalCost += run.costUsd;
    }
  }
  const totalCostUsd = allNull ? null : totalCost;

  // Aggregate corpus-wide scoreboard if judge ran
  const scoreboard: Scoreboard | undefined =
    allJudgements.length > 0 ? aggregateVerdicts(allJudgements) : undefined;

  // Per-variant rollups, anchored to (baseline profile × config.model)
  const anchorVariantId =
    runs.find((r) => r.profileId === 'baseline' && r.model === config.model)?.variantId ?? null;
  const rollups = computeRollups(runs, allJudgements, anchorVariantId);

  // Build report input
  const reportInput: ReportInput = {
    byProject: reportByProject,
    totalCostUsd,
    rollups,
    ...(anchorVariantId !== null ? { anchorVariantId } : {}),
    ...(scoreboard !== undefined ? { scoreboard } : {}),
  };

  // Write output files
  mkdirSync(opts.outDir, { recursive: true });

  const htmlPath = join(opts.outDir, 'report.html');
  const mdPath = join(opts.outDir, 'report.md');
  const jsonPath = join(opts.outDir, 'report.json');

  writeFileSync(htmlPath, renderReportHtml(reportInput), 'utf-8');
  writeFileSync(mdPath, renderReportMarkdown(reportInput), 'utf-8');
  writeFileSync(jsonPath, reportJson(reportInput), 'utf-8');

  return { reportPath: htmlPath, totalCostUsd };
}

// ---------------------------------------------------------------------------
// main() — thin CLI wrapper
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { loadRuntimeConfig } = await import('./settings.js');
  const { createDispatchingLlmClient } = await import('./llm/index.js');
  const { openRouterKeyRef, UsageReporter } = await import('./usage-reporter.js');

  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand !== 'snapshot' && subcommand !== 'run') {
    console.error('Usage: eval <snapshot|run> [options]');
    console.error('  snapshot [--corpus eval/corpus.json] [--projects a,b]');
    console.error('  run --profiles baseline [--models <ref,ref>] [--projects a,b] [--live] [--judge] [--judge-model <m>] [--tag <t>]');
    process.exit(1);
  }

  // Parse flags
  function flag(name: string): string | undefined {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  }
  function boolFlag(name: string): boolean {
    return args.includes(name);
  }

  const { bootstrap, config, engine, catalog } = await loadRuntimeConfig();

  // Benchmark spend is segregated in the ledger: default the experiment stamp to
  // eval:<tag|stamp> so usage-report can filter it out of prod-spend analysis.
  // The ledger's model column already distinguishes variants within a run.
  const stamp = Date.now();
  const evalTag = flag('--tag') ?? String(stamp);
  const reporter = new UsageReporter(engine, {
    provider: providerForModel(config.modelProviders),
    experiment: bootstrap.experiment ?? `eval:${evalTag}`,
    variant: bootstrap.variant,
    openRouterKeyRef: openRouterKeyRef(bootstrap.llmKeys),
  });
  const llm = reporter.wrap(createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders), { reasoningEffort: config.reasoningEffort }));

  await engine.connect();

  const fixturesDir = '.eval/fixtures';

  try {
    if (subcommand === 'snapshot') {
      const corpusPath = flag('--corpus') ?? 'eval/corpus.json';
      const projectsArg = flag('--projects');
      const projects = projectsArg ? projectsArg.split(',').map((s) => s.trim()) : undefined;

      const paths = await runSnapshot(
        { engine, llm, config },
        { corpusPath, fixturesDir, projects },
      );
      console.log(`Snapshotted ${paths.length} fixture(s).`);
    } else {
      const profilesArg = flag('--profiles') ?? 'baseline';
      const profileIds = profilesArg.split(',').map((s) => s.trim());
      const projectsArg = flag('--projects');
      const projects = projectsArg ? projectsArg.split(',').map((s) => s.trim()) : undefined;
      const live = boolFlag('--live');
      const judge = boolFlag('--judge');
      // Model refs resolve through the Settings/Models catalog (title or raw id) so the
      // dispatching client routes their provider; unmatched refs pass through as raw
      // fireworks ids. The judge warning is suppressed unless --judge is active.
      const judgeRef = flag('--judge-model') ?? 'Claude Sonnet 4.6';
      const judgeModel = resolveCliModelRef(catalog, judgeRef, {
        flagName: '--judge-model',
        registerProvider: (m, p) => { config.modelProviders[m] = p; },
        quiet: !judge,
      }).model;
      const modelsArg = flag('--models');
      let models: EvalModel[] | undefined;
      if (modelsArg !== undefined) {
        const seen = new Set<string>();
        models = [];
        for (const ref of modelsArg.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
          const resolved = resolveCliModelRef(catalog, ref, {
            flagName: '--models',
            registerProvider: (m, p) => { config.modelProviders[m] = p; },
          });
          if (seen.has(resolved.model)) continue;
          seen.add(resolved.model);
          models.push(resolved);
        }
      }
      // Resolve the anchor's label through the catalog too, so the auto-included
      // anchor gets the same variant id it would get if listed in --models.
      if (models !== undefined && !models.some((m) => m.model === config.model)) {
        models.unshift(resolveCliModelRef(catalog, config.model, {
          flagName: '--models',
          registerProvider: (m, p) => { config.modelProviders[m] = p; },
          quiet: true,
        }));
      }
      const outDir = `.eval/runs/${evalTag}`;

      const { reportPath, totalCostUsd } = await runEval(
        { engine, llm, config },
        { fixturesDir, outDir, profileIds, ...(models !== undefined ? { models } : {}), projects, live, judge, judgeModel },
      );

      console.log(`Report written to: ${reportPath}`);
      if (totalCostUsd !== null) {
        console.log(`Total cost: $${totalCostUsd.toFixed(4)}`);
      }
    }
  } finally {
    // Usage rows are written in the background; closing first would drop the last call's (#386).
    await reporter.flush();
    await engine.close();
  }
}

// Run main only when invoked directly (tsx src/eval.ts)
// ESM: import.meta.url check
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/eval.ts') || process.argv[1].endsWith('/eval.js'));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
