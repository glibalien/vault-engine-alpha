// Pure deterministic metrics for synthesized wiki sections. No I/O; no side
// effects. All functions are safe to call with arbitrary markdown strings.

import type { ProjectEvidence } from '../types.js';

export interface EvalSections {
  now: string;
  focus: string;
  open_threads: string;
  log_entry: string;
  at_a_glance?: string;
}

export interface EvalMetrics {
  words: { now: number; focus: number; open_threads: number; log_entry: number; at_a_glance: number; total: number };
  formatting: { callouts: number; tables: number; checkboxes: number; mermaid: number; bullets: number; headings: number };
  wikilinks: { total: number; resolvedInEvidence: number; unverified: string[] };
  /** Done/done_recent task titles whose distinctive tokens appear in focus/open_threads.
   *  HIGH-RECALL heuristic: matches on ALL alphanumeric tokens of length ≥ 4 from the
   *  done title appearing as whole words (case-insensitive) in the checked text. This
   *  will produce false positives for very common long words, but is zero-dependency and
   *  sufficient for an eval flag. */
  doneLeaks: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (also exported for direct unit testing)
// ---------------------------------------------------------------------------

/** Count whitespace-delimited words in a string. */
export function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

/** Extract wikilink targets from a string. Alias form [[target|alias]] returns target.
 *  Returns trimmed target strings. */
export function extractWikilinks(s: string): string[] {
  const results: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const target = m[1];
    if (target !== undefined) results.push(target.trim());
  }
  return results;
}

/** Collect all titles present in evidence: project, notes, all task buckets,
 *  recent + upcoming meetings, people, companies, existing wiki subpages. */
export function evidenceTitles(evidence: ProjectEvidence): Set<string> {
  const titles = new Set<string>();
  titles.add(evidence.project.title);

  for (const note of evidence.notes ?? []) titles.add(note.title);

  for (const bucket of Object.values(evidence.tasks ?? {})) {
    for (const task of bucket ?? []) titles.add(task.title);
  }

  for (const m of evidence.meetings?.recent ?? []) titles.add(m.title);
  for (const m of evidence.meetings?.upcoming ?? []) titles.add(m.title);

  for (const p of evidence.contacts?.people ?? []) titles.add(p.title);
  for (const c of evidence.contacts?.companies ?? []) titles.add(c.title);

  for (const sp of evidence.existing_wiki?.subpages ?? []) titles.add(sp.title);

  return titles;
}

/** Return task titles from the done_recent bucket. */
export function doneTaskTitles(evidence: ProjectEvidence): string[] {
  return (evidence.tasks?.['done_recent'] ?? []).map((t) => t.title);
}

// ---------------------------------------------------------------------------
// Formatting counters (operate on the full concatenated text of all sections)
// ---------------------------------------------------------------------------

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function countFormatting(text: string): EvalMetrics['formatting'] {
  const callouts = countMatches(text, /^\s*>\s*\[!\w+\]/gm);

  // Table separator rows: lines matching |?[ :|-]* with at least 3 consecutive dashes
  const tables = countMatches(text, /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm);

  const checkboxes = countMatches(text, /^\s*[-*]\s+\[[ xX]\]/gm);

  // Count occurrences of opening ```mermaid fence
  const mermaid = countMatches(text, /^```mermaid$/gm);

  const bullets = countMatches(text, /^\s*[-*]\s+/gm);

  const headings = countMatches(text, /^\s*#{1,6}\s+/gm);

  return { callouts, tables, checkboxes, mermaid, bullets, headings };
}

// ---------------------------------------------------------------------------
// Done-leak detection
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase alphanumeric tokens of length ≥ 4. */
function distinctiveTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

function detectDoneLeaks(sections: EvalSections, evidence: ProjectEvidence): string[] {
  const haystack = (sections.focus + '\n' + sections.open_threads).toLowerCase();
  const doneTitles = doneTaskTitles(evidence);
  const leaks: string[] = [];

  for (const title of doneTitles) {
    const tokens = distinctiveTokens(title);
    // No distinctive tokens → skip (avoids false positives from very short titles)
    if (tokens.length === 0) continue;
    // All tokens must appear as whole words (case-insensitive) in the haystack
    const allMatch = tokens.every((tok) => {
      const wordRe = new RegExp(`\\b${tok}\\b`, 'i');
      return wordRe.test(haystack);
    });
    if (allMatch) leaks.push(title);
  }

  // Dedup (done_recent could theoretically repeat titles)
  return [...new Set(leaks)];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function computeMetrics(sections: EvalSections, evidence: ProjectEvidence): EvalMetrics {
  const nowW = countWords(sections.now);
  const focusW = countWords(sections.focus);
  const openW = countWords(sections.open_threads);
  const logW = countWords(sections.log_entry);
  const glanceW = countWords(sections.at_a_glance ?? '');

  const allText = [
    sections.now,
    sections.focus,
    sections.open_threads,
    sections.log_entry,
    sections.at_a_glance ?? '',
  ].join('\n');

  const formatting = countFormatting(allText);

  const allLinks = extractWikilinks(allText);
  const knownTitles = evidenceTitles(evidence);
  const resolvedLinks = allLinks.filter((l) => knownTitles.has(l));
  const unverifiedLinks = [...new Set(allLinks.filter((l) => !knownTitles.has(l)))].sort();

  const doneLeaks = detectDoneLeaks(sections, evidence);

  return {
    words: {
      now: nowW,
      focus: focusW,
      open_threads: openW,
      log_entry: logW,
      at_a_glance: glanceW,
      total: nowW + focusW + openW + logW + glanceW,
    },
    formatting,
    wikilinks: {
      total: allLinks.length,
      resolvedInEvidence: resolvedLinks.length,
      unverified: unverifiedLinks,
    },
    doneLeaks,
  };
}
