import { marked } from 'marked';
import type { RunOutput } from './runner.js';
import type { EvalMetrics } from './metrics.js';
import type { JudgeVerdict, Scoreboard } from './judge.js';
import type { VariantRollup } from './rollup.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReportInput {
  byProject: Array<{
    project: string;
    variants: Array<{ run: RunOutput; metrics: EvalMetrics }>;
    judgements?: Array<{ aId: string; bId: string; verdict: JudgeVerdict; orderSplit?: boolean }>;
  }>;
  totalCostUsd: number | null;
  scoreboard?: Scoreboard;
  rollups?: VariantRollup[];
  anchorVariantId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape HTML special chars for safe inline embedding. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSectionMd(md: string): string {
  // marked.parse is synchronous when no async extensions are used
  const result = marked.parse(md);
  if (typeof result === 'string') return result;
  // Should never happen in synchronous mode, but handle gracefully
  return `<pre>${esc(md)}</pre>`;
}

function metricTableHtml(variants: Array<{ run: RunOutput; metrics: EvalMetrics }>): string {
  function row(label: string, vals: Array<string | number>): string {
    const cells = vals.map((v) => `<td>${esc(String(v))}</td>`).join('');
    return `<tr><td><strong>${esc(label)}</strong></td>${cells}</tr>`;
  }

  const rows = [
    row(
      'Words (total)',
      variants.map((v) => v.metrics.words.total),
    ),
    row(
      'Words (now)',
      variants.map((v) => v.metrics.words.now),
    ),
    row(
      'Words (focus)',
      variants.map((v) => v.metrics.words.focus),
    ),
    row(
      'Words (open_threads)',
      variants.map((v) => v.metrics.words.open_threads),
    ),
    row(
      'Words (log_entry)',
      variants.map((v) => v.metrics.words.log_entry),
    ),
    row(
      'Callouts',
      variants.map((v) => v.metrics.formatting.callouts),
    ),
    row(
      'Tables',
      variants.map((v) => v.metrics.formatting.tables),
    ),
    row(
      'Bullets',
      variants.map((v) => v.metrics.formatting.bullets),
    ),
    row(
      'Headings',
      variants.map((v) => v.metrics.formatting.headings),
    ),
    row(
      'Checkboxes',
      variants.map((v) => v.metrics.formatting.checkboxes),
    ),
    row(
      'Mermaid blocks',
      variants.map((v) => v.metrics.formatting.mermaid),
    ),
    row(
      'Wikilinks (total)',
      variants.map((v) => v.metrics.wikilinks.total),
    ),
    row(
      'Wikilinks (unverified)',
      variants.map((v) => v.metrics.wikilinks.unverified.length),
    ),
    row(
      'Done leaks',
      variants.map((v) => v.metrics.doneLeaks.length),
    ),
    row(
      'Cost (USD)',
      variants.map((v) => (v.run.costUsd !== null ? `$${v.run.costUsd.toFixed(4)}` : 'n/a')),
    ),
    row(
      'Evidence chars',
      variants.map((v) => v.run.evidenceChars),
    ),
  ].join('\n');

  return `<table>
<thead><tr><th>Metric</th>${variants.map((v) => `<th>${esc(v.run.variantId)}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function judgementHtml(
  judgements: Array<{ aId: string; bId: string; verdict: JudgeVerdict; orderSplit?: boolean }>,
): string {
  if (judgements.length === 0) return '';

  const rows = judgements.map(({ aId, bId, verdict, orderSplit }) => {
    const winnerLabel =
      verdict.overall === 'A' ? esc(aId) : verdict.overall === 'B' ? esc(bId) : 'tie';
    return `<tr>
  <td>${esc(aId)} vs ${esc(bId)}</td>
  <td><strong>${winnerLabel}</strong>${orderSplit === true ? ' ⚠ order-split' : ''}</td>
  <td>${Object.entries(verdict.criteria)
    .map(([k, v]) => {
      const w = v.winner === 'A' ? esc(aId) : v.winner === 'B' ? esc(bId) : 'tie';
      return `${esc(k)}: <em>${w}</em>`;
    })
    .join(', ')}</td>
</tr>`;
  });

  return `<h4>Judge Scoreboard</h4>
<table>
<thead><tr><th>Pair</th><th>Winner</th><th>Per-Criterion</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>`;
}

function scoreboardHtml(scoreboard: Scoreboard): string {
  const rows = Object.entries(scoreboard.wins)
    .sort((a, b) => b[1] - a[1])
    .map(([id, wins]) => `<tr><td>${esc(id)}</td><td>${wins}</td></tr>`)
    .join('\n');
  return `<h2>Corpus Scoreboard</h2>
<p>Pairs judged: ${scoreboard.pairs} | Ties: ${scoreboard.ties}</p>
<table>
<thead><tr><th>Variant</th><th>Wins</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function scoreboardMarkdown(scoreboard: Scoreboard): string {
  const lines: string[] = [];
  lines.push('## Corpus Scoreboard');
  lines.push('');
  lines.push(`Pairs judged: ${scoreboard.pairs} | Ties: ${scoreboard.ties}`);
  lines.push('');
  lines.push('| Variant | Wins |');
  lines.push('| --- | --- |');
  for (const [id, wins] of Object.entries(scoreboard.wins).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${id} | ${wins} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function rollupsHtml(rollups: VariantRollup[], anchorVariantId?: string): string {
  if (rollups.length === 0) return '';
  const rows = rollups
    .map((r) => {
      const name = r.variantId === anchorVariantId ? `${esc(r.variantId)} (anchor)` : esc(r.variantId);
      const cost = r.totalCostUsd !== null ? `$${r.totalCostUsd.toFixed(4)}` : 'n/a';
      const ratio = r.costVsAnchor !== null ? `${r.costVsAnchor.toFixed(2)}×` : 'n/a';
      const judge = r.judge !== null ? `${r.judge.wins}-${r.judge.losses}-${r.judge.ties}` : '—';
      const splits = r.judge !== null ? String(r.judge.orderSplits) : '—';
      return `<tr><td>${name}</td><td>${esc(r.model)}</td><td>${r.runs}</td><td>${r.usage.input}</td><td>${r.usage.output}</td><td>${cost}</td><td>${ratio}</td><td>${judge}</td><td>${splits}</td></tr>`;
    })
    .join('\n');
  return `<h2>Variants</h2>
<table>
<thead><tr><th>Variant</th><th>Model</th><th>Runs</th><th>Input toks</th><th>Output toks</th><th>Cost</th><th>×Anchor</th><th>Judge W-L-T</th><th>Order splits</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function rollupsMarkdown(rollups: VariantRollup[], anchorVariantId?: string): string {
  if (rollups.length === 0) return '';
  const lines: string[] = [];
  lines.push('## Variants');
  lines.push('');
  lines.push('| Variant | Model | Runs | Input toks | Output toks | Cost | ×Anchor | Judge W-L-T | Order splits |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rollups) {
    const name = r.variantId === anchorVariantId ? `${r.variantId} (anchor)` : r.variantId;
    const cost = r.totalCostUsd !== null ? `$${r.totalCostUsd.toFixed(4)}` : 'n/a';
    const ratio = r.costVsAnchor !== null ? `${r.costVsAnchor.toFixed(2)}×` : 'n/a';
    const judge = r.judge !== null ? `${r.judge.wins}-${r.judge.losses}-${r.judge.ties}` : '—';
    const splits = r.judge !== null ? String(r.judge.orderSplits) : '—';
    lines.push(`| ${name} | ${r.model} | ${r.runs} | ${r.usage.input} | ${r.usage.output} | ${cost} | ${ratio} | ${judge} | ${splits} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CSS — inline, no external references
// ---------------------------------------------------------------------------

const INLINE_CSS = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; color: #222; background: #fff; }
h1, h2, h3, h4 { margin-top: 1.5rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f5f5f5; font-weight: 600; }
tr:nth-child(even) { background: #fafafa; }
blockquote { border-left: 4px solid #0070c0; background: #f0f7ff; margin: 0.5rem 0; padding: 0.5rem 1rem; border-radius: 2px; }
code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.88em; }
pre { background: #f4f4f4; padding: 1rem; border-radius: 4px; overflow-x: auto; }
pre code { background: none; padding: 0; }
.variant-grid { display: grid; gap: 1rem; margin: 1rem 0; }
.variant-card { border: 1px solid #e0e0e0; border-radius: 6px; padding: 1rem; }
.variant-card h4 { margin-top: 0; color: #0070c0; }
.section-label { font-weight: 600; color: #555; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1rem; }
.cost-header { color: #555; font-size: 0.9rem; }
`.trim();

// ---------------------------------------------------------------------------
// renderReportHtml
// ---------------------------------------------------------------------------

export function renderReportHtml(input: ReportInput): string {
  const costStr =
    input.totalCostUsd !== null ? `$${input.totalCostUsd.toFixed(4)}` : 'cost unavailable';
  const rollupsSection = input.rollups !== undefined ? rollupsHtml(input.rollups, input.anchorVariantId) : '';

  const projectSections = input.byProject
    .map(({ project, variants, judgements }) => {
      const variantCards = variants
        .map(({ run }) => {
          const sections = run.sections;
          return `<div class="variant-card">
  <h4>${esc(run.variantId)}</h4>
  <div class="section-label">Now</div>
  ${renderSectionMd(sections.now)}
  <div class="section-label">Focus</div>
  ${renderSectionMd(sections.focus)}
  <div class="section-label">Open Threads</div>
  ${renderSectionMd(sections.open_threads)}
  <div class="section-label">Log Entry</div>
  ${renderSectionMd(sections.log_entry)}
  ${sections.at_a_glance ? `<div class="section-label">At a Glance</div>\n  ${renderSectionMd(sections.at_a_glance)}` : ''}
</div>`;
        })
        .join('\n');

      const metricsTable = metricTableHtml(variants);
      const judgeHtml = judgementHtml(judgements ?? []);

      return `<section>
<h2>${esc(project)}</h2>
<div class="variant-grid">
${variantCards}
</div>
<h3>Metrics</h3>
${metricsTable}
${judgeHtml}
</section>`;
    })
    .join('\n<hr>\n');

  const scoreboardSection = input.scoreboard ? `\n${scoreboardHtml(input.scoreboard)}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval Report</title>
<style>
${INLINE_CSS}
</style>
</head>
<body>
<h1>Eval Report</h1>
<p class="cost-header">Total cost: <strong>${esc(costStr)}</strong></p>
${rollupsSection}
${projectSections}${scoreboardSection}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// renderReportMarkdown
// ---------------------------------------------------------------------------

export function renderReportMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  const costStr =
    input.totalCostUsd !== null ? `$${input.totalCostUsd.toFixed(4)}` : 'cost unavailable';

  lines.push('# Eval Report');
  lines.push('');
  lines.push(`**Total cost:** ${costStr}`);
  lines.push('');
  if (input.rollups !== undefined) {
    lines.push(rollupsMarkdown(input.rollups, input.anchorVariantId));
  }

  for (const { project, variants, judgements } of input.byProject) {
    lines.push(`## ${project}`);
    lines.push('');

    // Metric table: header row
    const headerCols = ['Metric', ...variants.map((v) => v.run.variantId)];
    lines.push(`| ${headerCols.join(' | ')} |`);
    lines.push(`| ${headerCols.map(() => '---').join(' | ')} |`);

    function metricRow(label: string, vals: Array<string | number>): string {
      return `| ${[label, ...vals.map(String)].join(' | ')} |`;
    }

    lines.push(metricRow('words (total)', variants.map((v) => v.metrics.words.total)));
    lines.push(metricRow('words (now)', variants.map((v) => v.metrics.words.now)));
    lines.push(metricRow('words (focus)', variants.map((v) => v.metrics.words.focus)));
    lines.push(metricRow('words (open_threads)', variants.map((v) => v.metrics.words.open_threads)));
    lines.push(metricRow('words (log_entry)', variants.map((v) => v.metrics.words.log_entry)));
    lines.push(metricRow('callouts', variants.map((v) => v.metrics.formatting.callouts)));
    lines.push(metricRow('tables', variants.map((v) => v.metrics.formatting.tables)));
    lines.push(metricRow('bullets', variants.map((v) => v.metrics.formatting.bullets)));
    lines.push(metricRow('unverified links', variants.map((v) => v.metrics.wikilinks.unverified.length)));
    lines.push(metricRow('done leaks', variants.map((v) => v.metrics.doneLeaks.length)));
    lines.push(
      metricRow(
        'cost (USD)',
        variants.map((v) => (v.run.costUsd !== null ? `$${v.run.costUsd.toFixed(4)}` : 'n/a')),
      ),
    );
    lines.push('');

    if (judgements && judgements.length > 0) {
      for (const { aId, bId, verdict, orderSplit } of judgements) {
        const winner =
          verdict.overall === 'A' ? aId : verdict.overall === 'B' ? bId : 'tie';
        lines.push(`**Judge (${aId} vs ${bId}):** winner = \`${winner}\`${orderSplit === true ? ' ⚠ order-split' : ''}`);
      }
      lines.push('');
    }
  }

  if (input.scoreboard) {
    lines.push(scoreboardMarkdown(input.scoreboard));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// reportJson
// ---------------------------------------------------------------------------

export function reportJson(input: ReportInput): string {
  return JSON.stringify(input, null, 2);
}
