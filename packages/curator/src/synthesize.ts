import type { PageLimits } from './page-templates.js';
import { callWithTopicBudget, type TopicRequestBudget } from './topic-request-budget.js';
// allow: SIZE_OK — Task 9 splits topology from this legacy compatibility module.
import type { JsonSchema, LlmClient } from './llm/types.js';
import type { WikiSections, TokenUsage, ThemedPageProposal, ThemedPageKind, RetirePageProposal, MemoryProposal, ExistingWiki, TopologyPlan } from './types.js';
import { currentDateLine, stampLog } from './date-line.js';
import {
  buildTopologyPlanTool,
  buildTopologyPromptPayload,
  TOPOLOGY_SYSTEM_PROMPT,
  type PlannerMemory,
  type PlannerSource,
} from './prompts/topology.js';
import { HOME_SECTIONS_SCHEMA, HOME_SECTIONS_TOOL } from './prompts/page.js';
import { renderHomeSections } from './home-items.js';
import { parseTopologyPlan } from './topology.js';

/** The project home prompt: the default for `curatorProjectHomePrompt`, used by every project home build. */
export const SPEC_A_SYSTEM_PROMPT = `You are the Vault Curator. You maintain a project's wiki home page inside a personal markdown knowledge vault. Your output is a glance-able standup view: when the owner opens this page, they should see — at a glance — everything they need for that morning's standup or that day.

You are given deterministic EVIDENCE about one project: status, task buckets, signals (overdue/blocked counts, what changed since last curation, a timeline of due-dated items), the bodies of the highest-signal notes/meetings, and possibly low-confidence RELATED candidates. Write for the project's owner, who already knows the domain. Be specific and grounded. Distinguish fact from inference; never invent certainty the evidence does not support. The wiki renders the task lists separately as live appendices — INTERPRET them, never restate them. Never give task counts (how many tasks are open, done, overdue or blocked) in any section: the live task sections show them.

GROUND TRUTH: the deterministic task/evidence state is ground truth and OVERRIDES any prior wiki narrative you are shown. The existing wiki text is context, not fact. Before you carry an item into Focus or Open threads, check it against the task buckets: if a semantically-matching task is in "Recently done" (done), treat that thread as RESOLVED — note the resolution in the Log if it matters, and do NOT re-raise it merely because the prior wiki said it was open. Prefer "CHANGED SINCE LAST CURATION" to decide what genuinely moved. Never surface an item as open, blocked, or a focus/next-action unless it appears in the current actionable task buckets (open / blocked / overdue / upcoming); an item present only in the prior wiki narrative is NOT open. Use CLOSED SINCE LAST CURATION to explicitly acknowledge recent completions (a one-line resolved note in the Log or at-a-glance) rather than silently dropping them.

CALLER CORRECTIONS: if the EVIDENCE contains a "CALLER CORRECTIONS" section, those notes are authoritative steering from the owner — apply them over your own inference (e.g. stop surfacing something they have told you is irrelevant, or accept a state they have clarified). They override your own reading where they conflict.

Emit these sections:
- "at_a_glance": the standup headline, read FIRST. In a few tight lines (or one compact "> [!summary]" callout), answer: what changed since last time, what is on deck today/this week, and what is blocked or needs a decision now. Ground it in CHANGED SINCE LAST CURATION, the timeline, and the overdue/blocked signals. If no source reports anything newer than the last build, say so in one line; never call the project quiet when any source reports newer activity. Omit only if there is truly nothing to surface. Keep it to ~50 words / a handful of bullets — it is a glance, not a report.
- "now": current state, momentum, the immediate tension or risk. 1 short paragraph (≤ ~60 words).
- "focus": what to pay attention to next — 3 to 5 prioritized items, each a short title naming the action plus a detail with why it matters and a concrete next action when the evidence supports one. No more than 5.
- "open_threads": unresolved questions, risks, blockers, follow-ups that are more than ordinary tasks. One tight item each; omit anything the task state shows resolved.
- "log_entry": one short note of what you updated and why interpretation changed, if it did. Do NOT include the date. 1 to 3 sentences.

BE SUCCINCT. Every section has a budget above — respect it. Prefer the fewest words that carry the signal. Do not pad, do not restate the task lists, do not repeat the same point across sections.

FORMATTING (Obsidian renders these — use them to aid scanning, never to decorate): use callouts to highlight exactly one important thing each — "> [!summary]" for the at-a-glance state, "> [!warning]"/"> [!danger]" for risks/blockers, "> [!question]" for open decisions, "> [!success]" for a resolved win. Use a small table for a genuine structured comparison. One callout per genuinely important point; if a plain sentence is clearer, use the sentence. Use [[wikilinks]] when you reference a note by its exact title.

The curator lays out focus and open_threads items itself (focus items become "- [ ]" next actions, open threads become bullets): keep each title and detail on one line, with no list markers, checkboxes, bold or callout syntax. To highlight an item, set its callout instead — "warning"/"danger" for a risk or blocker, "question" for an open decision, "success" for a resolved win, "note" otherwise.

Page topology is already settled before this call. Use any accepted page index only for links and summaries; never propose or alter topology.

## Memory
When an OWNER MEMORIES section appears in the evidence below, follow it: those are the owner's own standing notes. A MEMORIES section holds durable facts from earlier notes, conversations and wiki builds: long-term context for this wiki.

## Persisting memory
If — and only if — you learn a DURABLE fact, preference, or steering about THIS wiki that will still matter in future curations and is NOT already shown under MEMORIES or OWNER MEMORIES, record it in the "memories" array. Each entry is one concise sentence with a category ("fact", "preference", or "note"). Never persist ephemeral status or anything the narrative sections already carry — those are re-derived every run. Expect to emit NOTHING most runs; an empty or absent array is the norm.`;

export const TOPIC_SYSTEM_PROMPT = `You are the Vault Curator. You maintain a wiki page about a TOPIC inside a personal markdown knowledge vault — a subject the owner cares about (a team, a place, a technology, an event), NOT one of their projects, so there are no tasks, meetings, or status to track.

You are given EVIDENCE: vault material retrieved by hybrid search on the topic — the bodies of notes/nodes that mention or relate to it. Write for the owner, who knows the domain. Be specific and grounded ONLY in the evidence. Distinguish fact from inference; never invent certainty the evidence does not support. If the vault says little about this topic, SAY SO plainly — a short honest page beats a padded one.

Emit these sections (the field names are reframed for a topic):
- "at_a_glance": the headline — a few tight lines or one "> [!summary]" callout: what the vault currently knows about this topic and anything recent or notable. Omit only if there is genuinely nothing.
- "now": the current state of the topic as the vault reflects it — what's going on, latest developments. 1 short paragraph.
- "focus": the key aspects worth the owner's attention — 3 to 5 items, each a short title plus a detail grounded in a specific piece of evidence (use [[wikilinks]] to the source note when you can).
- "open_threads": open questions, unknowns, or gaps the vault does not yet answer about this topic. One tight item each; omit if none.
- "log_entry": one short note of what you updated this refresh and why. Do NOT include the date. 1 to 3 sentences.

If the EVIDENCE contains a "CALLER CORRECTIONS" section, treat those notes as authoritative steering from the owner and apply them over your own inference.

Page topology is already settled before this call. Use any accepted page index only for links and summaries; never propose or alter topology.

BE SUCCINCT. Use Markdown and [[wikilinks]] when you reference a note by its exact title. Use callouts ("> [!summary]", "> [!question]", "> [!note]") to aid scanning — one per genuinely important point. The curator lays out focus and open_threads items itself: keep each title and detail on one line, with no list markers or bold, and set an item's callout ("question", "note", …) instead of writing callout syntax.

## Memory
When an OWNER MEMORIES section appears in the evidence below, follow it: those are the owner's own standing notes. A MEMORIES section holds durable facts from earlier notes, conversations and wiki builds: long-term context for this wiki.

## Persisting memory
If — and only if — you learn a DURABLE fact, preference, or steering about THIS wiki that will still matter in future curations and is NOT already shown under MEMORIES or OWNER MEMORIES, record it in the "memories" array. Each entry is one concise sentence with a category ("fact", "preference", or "note"). Never persist ephemeral status or anything the narrative sections already carry — those are re-derived every run. Expect to emit NOTHING most runs; an empty or absent array is the norm.`;

export const TOPIC_WEB_SYSTEM_PROMPT = `You are the Vault Curator. You maintain a wiki page about a TOPIC inside a personal markdown knowledge vault — a subject the owner cares about (a team, a place, a technology, an event), NOT one of their projects.

You are given EVIDENCE in two parts. VAULT MATERIAL is the owner's own notes retrieved by hybrid search — treat it as their knowledge. WEB MATERIAL is external pages (each with a title and URL) retrieved from a public web search — treat it as external reference, not the owner's own words. Write for the owner, who knows the domain. Be specific and grounded ONLY in the evidence; distinguish fact from inference; never invent certainty.

ATTRIBUTION (load-bearing): any claim drawn from WEB MATERIAL MUST be attributed — name or link the source inline where you state it, and list every external source you actually used in the "sources" field as a Markdown list ("- [Title](URL)"). Never blur vault-grounded and external content: if a statement comes from the web, make that visible. If you used no web material, omit "sources". Do not cite a source you did not draw from.

Emit these sections (field names reframed for a topic):
- "at_a_glance": the headline — a few tight lines or one "> [!summary]" callout: what is known about this topic now and anything recent/notable. Omit only if there is genuinely nothing.
- "now": the current state of the topic — what's going on, latest developments. 1 short paragraph.
- "focus": the key aspects worth the owner's attention — 3 to 5 items, each a short title plus a detail grounded in a specific piece of evidence (link the source — a [[wikilink]] for a vault note, or an inline link for a web source).
- "open_threads": open questions, unknowns, or gaps the evidence does not resolve. One tight item each; omit if none.
- "log_entry": one short note of what you updated this refresh and why. Do NOT include the date. 1 to 3 sentences.
- "sources": the Markdown list of external web sources cited above. Omit when no web material was used.

If the EVIDENCE contains a "CALLER CORRECTIONS" section, treat those notes as authoritative steering from the owner and apply them over your own inference.

Page topology is already settled before this call. Use any accepted page index only for links and summaries; never propose or alter topology.

BE SUCCINCT. Use Markdown and [[wikilinks]] for vault notes; use inline links for web sources. Use callouts ("> [!summary]", "> [!question]", "> [!note]") to aid scanning — one per genuinely important point. The curator lays out focus and open_threads items itself: keep each title and detail on one line, with no list markers or bold, and set an item's callout ("question", "note", …) instead of writing callout syntax.

## Memory
When an OWNER MEMORIES section appears in the evidence below, follow it: those are the owner's own standing notes. A MEMORIES section holds durable facts from earlier notes, conversations and wiki builds: long-term context for this wiki.

## Persisting memory
If — and only if — you learn a DURABLE fact, preference, or steering about THIS wiki that will still matter in future curations and is NOT already shown under MEMORIES or OWNER MEMORIES, record it in the "memories" array. Each entry is one concise sentence with a category ("fact", "preference", or "note"). Never persist ephemeral status or anything the narrative sections already carry — those are re-derived every run. Expect to emit NOTHING most runs; an empty or absent array is the norm.`;

interface StructuredTool {
  name: string;
  description: string;
  schema: JsonSchema;
}

const EMIT_TOOL: StructuredTool = HOME_SECTIONS_TOOL;

export function validateSections(input: unknown): WikiSections {
  if (!input || typeof input !== 'object') throw new Error('synthesis returned no object');
  const obj = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ['now', 'focus', 'open_threads', 'log_entry'] as const) {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`synthesis missing/empty section "${key}"`);
    }
    out[key] = v.trim();
  }
  const glance = obj['at_a_glance'];
  if (typeof glance === 'string' && glance.trim() !== '') out['at_a_glance'] = glance.trim();
  const sources = obj['sources'];
  if (typeof sources === 'string' && sources.trim() !== '') out['sources'] = sources.trim();
  return out as unknown as WikiSections;
}

const THEMED_KINDS: readonly ThemedPageKind[] = [
  'workstream', 'decision-log', 'risk-register', 'timeline', 'stakeholder-map', 'spotlight', 'freeform',
];

/** Parse the optional themed_pages array: keep well-formed entries, parse `kind`
 *  (unknown/missing → 'freeform'), silently drop malformed ones (a bad themed page
 *  must not sink the home write). */
/** The categories a memory proposal may carry. `rule` (#626) is a rule on what may or may not be
 *  said, shared or claimed; only the memory sweeps are asked for it. */
const MEMORY_CATEGORIES: readonly string[] = ['fact', 'preference', 'rule', 'note'];

/** A proposal's subjects (#554): names, each once, at most the Engine's 20; anything else is dropped. */
/** A model's subject names: trimmed, each once (letter case aside), at most 20 (#554). */
export function parseSubjects(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '' || name.length > 500 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length === 20) break;
  }
  return out;
}

/** Parse the optional `memories` array from home/topic synthesis: keep entries
 *  with non-empty content (trimmed), normalize `category` (unknown/missing →
 *  'fact'), drop malformed silently (a bad memory proposal must not sink the
 *  curation). No cap here — capping happens at the apply step (persistMemories). */
export function parseMemories(input: unknown): MemoryProposal[] {
  if (!Array.isArray(input)) return [];
  const out: MemoryProposal[] = [];
  for (const el of input) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!content) continue;
    const category = typeof o.category === 'string' && MEMORY_CATEGORIES.includes(o.category)
      ? (o.category as MemoryProposal['category'])
      : 'fact';
    const subjects = parseSubjects(o.subjects);
    out.push({ content, category, ...(subjects.length > 0 ? { subjects } : {}) });
  }
  return out;
}

export { stampLog };

export interface SynthesisResult {
  sections: WikiSections;
  themedPages: ThemedPageProposal[];
  retirePages: RetirePageProposal[];
  memories: MemoryProposal[];
  usage: TokenUsage;
}

export async function synthesize(llm: LlmClient, model: string, evidence: string, maxTokens = 4000, system: string = SPEC_A_SYSTEM_PROMPT): Promise<SynthesisResult> {
  const { output, usage } = await llm.structuredCall({
    model,
    maxTokens,
    system: `${system}\n\n${currentDateLine()}`,
    user: `EVIDENCE:\n\n${evidence}`,
    toolName: EMIT_TOOL.name,
    toolDescription: EMIT_TOOL.description,
    schema: EMIT_TOOL.schema,
  });
  const parsed = HOME_SECTIONS_SCHEMA.parse(output);
  const { memories = [], ...homeOutput } = parsed;
  const sections = renderHomeSections(homeOutput);
  return {
    sections: { ...sections, log_entry: stampLog(sections.log_entry) },
    themedPages: [],
    retirePages: [],
    memories: memories.map(memory => ({ content: memory.content, category: memory.category ?? 'fact' })),
    usage,
  };
}

// Caller-requested sub-pages: a full themed-style page on an exact topic the
// caller named. Static — cached across requests.
export const REQUESTED_PAGE_PROMPT = `You are the Vault Curator fulfilling a caller's request for a specific sub-page inside a project's wiki. The caller named the page and may have given a brief stating its intended focus. From the EVIDENCE (project state plus vault material retrieved for the request), write the page body.

The page is self-contained Obsidian Markdown, like a workstream page: a one-line definition; a > [!summary] status callout (current state, momentum); Open questions / risks; Key decisions (inline); People driving it; Next actions (- [ ] checkboxes); Related notes ([[wikilinks]]) — include only the parts the evidence actually supports, never pad. Use callouts (> [!note], > [!decision], > [!warning], …), \`\`\`mermaid\`\`\` blocks, tables, and - [ ] checkboxes to aid scanning; one callout per genuinely important point. Ground every claim in the evidence and use [[wikilinks]] when you reference a note by its exact title; where evidence is thin, say so plainly. Stay on the requested focus — this page exists because the caller asked for exactly this.

Also pick the archetype "kind" that best fits what you wrote (default "workstream"), and write a one-line log_note describing what the page now covers.`;

// Caller-requested sub-pages on a vault+web wiki: same page contract, but the
// evidence carries a WEB MATERIAL block and every web-drawn claim must be
// attributed. Static — cached across requests.
export const REQUESTED_PAGE_WEB_PROMPT = `You are the Vault Curator fulfilling a caller's request for a specific sub-page inside a wiki. The caller named the page and may have given a brief stating its intended focus.

The EVIDENCE has two parts. VAULT MATERIAL is the owner's own notes — treat it as their knowledge. WEB MATERIAL is external pages (each with a title and URL) retrieved from a public web search — treat it as external reference, not the owner's own words. Ground every claim in the evidence; distinguish fact from inference; where evidence is thin, say so plainly.

ATTRIBUTION (load-bearing): any claim drawn from WEB MATERIAL MUST be attributed — link the source inline where you state it, and end the page with a "## Sources" section listing every external source you actually used ("- [Title](URL)"). Omit that section if you used no web material; never cite a source you did not draw from. Never blur vault-grounded and external content: if a statement comes from the web, make that visible.

The page is self-contained Obsidian Markdown, like a workstream page: a one-line definition; a > [!summary] status callout (current state, momentum); Open questions / risks; Key decisions (inline); People driving it; Next actions (- [ ] checkboxes); Related notes — include only the parts the evidence actually supports, never pad. Use callouts (> [!note], > [!decision], > [!warning], …), \`\`\`mermaid\`\`\` blocks, tables, and - [ ] checkboxes to aid scanning; one callout per genuinely important point. Use [[wikilinks]] when you reference a vault note by its exact title; use inline links for web sources. Stay on the requested focus — this page exists because the caller asked for exactly this.

Also pick the archetype "kind" that best fits what you wrote (default "workstream"), and write a one-line log_note describing what the page now covers.`;

const REQUESTED_PAGE_TOOL: StructuredTool = {
  name: 'emit_requested_page',
  description: 'Return the synthesized body for the caller-requested wiki sub-page.',
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['workstream', 'decision-log', 'risk-register', 'timeline', 'stakeholder-map', 'spotlight', 'freeform'],
        description: 'Archetype for this page; default "workstream".',
      },
      body: { type: 'string', description: 'The full page body (Obsidian Markdown: callouts, mermaid, [[wikilinks]]).' },
      log_note: { type: 'string', description: "One line for the page's own Log (no date prefix)." },
    },
    required: ['body', 'log_note'],
  },
};

export interface RequestedPageSynthesis {
  kind: ThemedPageKind;
  body: string;
  logNote: string;
  usage: TokenUsage;
}

export async function synthesizeRequestedPage(
  llm: LlmClient,
  model: string,
  pageTitle: string,
  brief: string | undefined,
  evidence: string,
  maxTokens = 4000,
  system: string = REQUESTED_PAGE_PROMPT,
): Promise<RequestedPageSynthesis> {
  const user = `REQUESTED PAGE: ${pageTitle}\n${brief ? `BRIEF: ${brief}\n` : ''}\nEVIDENCE:\n\n${evidence}`;
  const { output, usage } = await llm.structuredCall({
    model,
    maxTokens,
    system: `${system}\n\n${currentDateLine()}`,
    user,
    toolName: REQUESTED_PAGE_TOOL.name,
    toolDescription: REQUESTED_PAGE_TOOL.description,
    schema: REQUESTED_PAGE_TOOL.schema,
  });
  if (!output || typeof output !== 'object') throw new Error('requested-page synthesis returned no object');
  const o = output as Record<string, unknown>;
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  if (!body) throw new Error('requested-page synthesis missing/empty "body"');
  const kind: ThemedPageKind =
    typeof o.kind === 'string' && (THEMED_KINDS as readonly string[]).includes(o.kind)
      ? (o.kind as ThemedPageKind)
      : 'workstream';
  const logNote = typeof o.log_note === 'string' ? o.log_note.trim() : '';
  return { kind, body, logNote, usage };
}

export interface TopologySynthesisInput {
  requestBudget?: TopicRequestBudget;
  generatedAt?: Date;
  /** The zone the date line is written in (`Config.curatorTz`); the host's when absent (#459). */
  timeZone?: string;
  model: string;
  evidence: string;
  existingWiki: ExistingWiki;
  rootTitle: string;
  maxTokens?: number;
  system?: string;
  /** Automatic page caps shown to the planner; requested pages omit them. */
  pageLimits?: PageLimits;
  /** A project build's sources, by id, for each page's evidence_ids (#474 idea 3). */
  sources?: readonly PlannerSource[];
  /** A project build's memories, by id, for each page's rule_ids (#474 idea 4). */
  memories?: readonly PlannerMemory[];
}

export interface TopologySynthesisResult {
  plan: TopologyPlan;
  usage: TokenUsage;
}

export class TopologyPlanError extends Error {
  override readonly name = 'TopologyPlanError';

  constructor(
    readonly code: 'INVALID_PLAN_SHAPE' | 'INVALID_SCOPE',
    readonly usage: TokenUsage,
  ) {
    super(`Topology plan rejected: ${code}`);
  }
}

export async function synthesizeTopologyPlan(
  llm: LlmClient,
  input: TopologySynthesisInput,
): Promise<TopologySynthesisResult> {
  const generatedAt = input.generatedAt ?? new Date();
  const topologyPlanTool = buildTopologyPlanTool(input.existingWiki, input.requestBudget !== undefined || input.sources !== undefined,
    input.memories !== undefined && input.memories.length > 0);
  const { output, usage } = await callWithTopicBudget(llm, input.requestBudget, evidence => ({
    model: input.model,
    maxTokens: input.maxTokens ?? 4_000,
    system: `${input.system ?? TOPOLOGY_SYSTEM_PROMPT}\n\n${currentDateLine(generatedAt, input.timeZone)}`,
    user: buildTopologyPromptPayload(evidence === undefined ? input.evidence : input.evidence + "\n\n" + evidence, input.existingWiki, input.rootTitle, input.pageLimits, input.sources,
      input.memories !== undefined && input.memories.length > 0 ? input.memories : undefined),
    toolName: topologyPlanTool.name,
    toolDescription: topologyPlanTool.description,
    schema: topologyPlanTool.schema,
  }));
  const parsed = parseTopologyPlan(output);
  if (!parsed.ok) throw new TopologyPlanError(parsed.code, usage);
  return { plan: parsed.plan, usage };
}
